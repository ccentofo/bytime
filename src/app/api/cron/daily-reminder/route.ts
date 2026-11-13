import { NextRequest } from 'next/server';
import { getDbForUrl } from '@/db';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { users, timesheetEntries, workspaceSettings } from '@/db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { dailyReminderMessage, type ReminderMessage } from '@/lib/email/reminder-messages';
import { deliverReminderBatch, reminderBatchKey, REMINDER_BATCH_SIZE, type BatchOutcome } from '@/lib/email/send-batch';
import { createSendThrottle } from '@/lib/email/rate';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { runCron } from '@/lib/cron/run-cron';
import { isSeedRecipient, sweepTenants, type CronStopReason } from '@/lib/cron/tenant-sweep';
import { getTenantAccess } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { dayOfWeek, formatCalendarDate, isValidTimeZone, todayIn } from '@/lib/calendar-date';

const FALLBACK_TIMEZONE = 'America/New_York';
const CRON = 'daily-reminder';
/** feature-plan-reminder-capacity.md §6.4: this many failed batches in a row stop the run ('email-failing'). */
const MAX_CONSECUTIVE_BATCH_FAILURES = 3;

/**
 * Cron endpoint: Send daily time entry reminders.
 * Should be called once per day (e.g., 4:00 PM local time) on weekdays.
 *
 * Iterates all active tenants and sends reminders to employees who have
 * NOT entered time for today.
 *
 * feature-plan-reminder-capacity.md §6.4: reminders go out through Resend's batch endpoint, up to 100 per request,
 * one workspace per request, each with a fixed idempotency key. A quota or configuration error, or three failed
 * batches in a row, stops the run's sending.
 *
 * Protect this endpoint with a CRON_SECRET header in production.
 */
// Audit R10: a literal — Next reads route segment config statically (an imported constant fails the build). Must
// equal REMINDER_CRON_MAX_DURATION_S (checked by unit/route-segment-config).
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  return runCron(request, 'daily-reminder', sendReminders, { maxRuntimeMinutes: 5 });
}

async function sendReminders(): Promise<Record<string, unknown>> {
  // Load all active tenants from the control plane
  // Only workspaces in `full` mode get reminders (read-only / billing-only / closed can't enter time).
  const now = new Date();
  const activeTenants = (await controlDb.select().from(tenants).where(eq(tenants.status, 'active')))
    .filter((t) => getTenantAccess(toLifecycleFacts(t), now) === 'full');

  let totalSent = 0;
  let totalFailed = 0;
  let batches = 0;
  let consecutiveBatchFailures = 0;
  // Shared Resend budget: ≤ 2 requests/second for this cron (feature-plan-launch-blockers.md P1 §5); a batch is one.
  const sendThrottle = createSendThrottle();

  let skippedSeedRecipients = 0;

  /** Count one batch outcome and update the run-level breaker. Returns a stop reason, or null to carry on. */
  function tally(outcome: BatchOutcome): CronStopReason | null {
    if (outcome.kind === 'disabled') return null; // no API key: nothing counted, breaker untouched
    batches++;
    if (outcome.kind === 'sent') totalSent += outcome.sent;
    totalFailed += outcome.failed;
    if (outcome.kind === 'stop') return outcome.reason;
    if (outcome.kind === 'sent' && outcome.sent > 0) consecutiveBatchFailures = 0;
    // A concurrent-409 means a duplicate run is sending the same batch, not that Resend is failing.
    else if (!(outcome.kind === 'failed' && outcome.errorName === 'concurrent_idempotent_requests')) consecutiveBatchFailures++;
    return consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES ? 'email-failing' : null;
  }

  // feature-plan-launch-blockers.md P6 §4: time budget, fair rotation, per-tenant failures isolated + reported.
  const sweep = await sweepTenants({
    name: CRON,
    tenants: activeTenants,
    processTenant: async (tenant, { outOfTime, resumeAfter, sendCutoff }) => {
      // T7: dbUrlEncrypted is only null for a tombstoned ('deleted') tenant; this query is
      // filtered to status='active', which a deleted tenant never has.
      const db = getDbForUrl(decrypt(tenant.dbUrlEncrypted!));

      // D7: "today" and the weekend skip are evaluated per-tenant, in THAT tenant's workspace
      // timezone — never the cron process's own (UTC) clock, which would call it Saturday for a
      // tenant where it's already Monday morning, or vice versa.
      const [settingsRow] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
      const timezone = settingsRow?.timezone && isValidTimeZone(settingsRow.timezone) ? settingsRow.timezone : FALLBACK_TIMEZONE;
      const today = todayIn(timezone);
      const dow = dayOfWeek(today);
      if (dow === 0 || dow === 6) return 'done';

      // Get all active employees for this tenant
      const allEmployees = await db
        .select({ id: users.id, fullName: users.fullName, email: users.email })
        .from(users)
        // Audit A10: id order, resuming after the last employee a stopped run finished in this tenant.
        .where(and(eq(users.isActive, true), eq(users.role, 'employee'), resumeAfter ? gt(users.id, resumeAfter) : undefined))
        .orderBy(users.id);

      // Find who has entered time today
      const entriesForToday = await db
        .select({ userId: timesheetEntries.userId })
        .from(timesheetEntries)
        .where(eq(timesheetEntries.entryDate, today));

      const usersWithEntries = new Set(entriesForToday.map((e) => e.userId));

      // One workspace per batch (never mixed); flushed at 100, when out of time, and at the end.
      const pending: { userId: string; message: ReminderMessage }[] = [];
      const flush = async (): Promise<CronStopReason | null> => {
        if (pending.length === 0) return null;
        const batch = pending.splice(0);
        await sendThrottle(); // one throttle per batch request
        return tally(await deliverReminderBatch(CRON, batch.map((p) => p.message), {
          idempotencyKey: reminderBatchKey(CRON, tenant.id, today, batch.map((p) => p.userId)),
          notAfter: sendCutoff,
        }));
      };

      let lastDone: string | null = resumeAfter;
      for (const emp of allEmployees) {
        // Audit A10: the budget is checked before EVERY employee (a big tenant with nothing to send still costs time);
        // past the check, this employee is handled completely. Queued reminders are sent before the tenant returns.
        // §6.4: an email stop keeps the position this run started from (resumeAfter), so the next day's run doesn't
        // skip employees in batches already sent.
        if (outOfTime()) {
          const stop = await flush();
          return stop ? { stoppedAfter: resumeAfter, reason: stop } : { stoppedAfter: lastDone };
        }
        lastDone = emp.id;
        if (usersWithEntries.has(emp.id)) continue;
        if (isSeedRecipient(emp.email)) { skippedSeedRecipients++; continue; } // P6 §4: demo domains we don't own

        // feature-plan-launch-hardening.md H1: employees can't opt out of the daily reminder (product owner 2026-11-11),
        // so there is no preference lookup — the notification_preferences.email_daily_reminder column is unused.
        pending.push({
          userId: emp.id,
          message: dailyReminderMessage({
            employeeEmail: emp.email,
            employeeName: emp.fullName,
            todayDate: formatCalendarDate(today, 'dddd, MMM D, YYYY'),
            appUrl: tenantBaseUrl(tenant.slug),
          }),
        });
        if (pending.length === REMINDER_BATCH_SIZE) {
          const stop = await flush();
          if (stop) return { stoppedAfter: resumeAfter, reason: stop };
        }
      }
      const stop = await flush();
      return stop ? { stoppedAfter: resumeAfter, reason: stop } : 'done';
    },
  });

  return {
    message: 'Daily reminders sent',
    sent: totalSent,
    failedSends: totalFailed,
    skippedSeedRecipients,
    processed: sweep.processed,
    candidates: sweep.candidates,
    incomplete: sweep.incomplete,
    failedTenants: sweep.failedTenants,
    failedTenantCount: sweep.failedTenants.length,
    cursor: sweep.cursor, // P6 §4: the next run starts after this slug
    resumes: sweep.resumes, // audit A10/R1: per tenant, where a stopped run resumes (after this employee)
    batches, // feature-plan-reminder-capacity.md §6.6: batch requests made (a retried batch counts once)
    stopReason: sweep.stopReason, // null, 'budget', 'email-quota', 'email-config' or 'email-failing'
  };
}
