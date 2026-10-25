import { NextRequest } from 'next/server';
import { getDbForUrl } from '@/db';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { users, timesheetEntries, notificationPreferences, workspaceSettings } from '@/db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { sendDailyReminderEmail } from '@/lib/email/send';
import { createSendThrottle } from '@/lib/email/rate';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { runCron } from '@/lib/cron/run-cron';
import { isSeedRecipient, sweepTenants } from '@/lib/cron/tenant-sweep';
import { getTenantAccess } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { dayOfWeek, formatCalendarDate, isValidTimeZone, todayIn } from '@/lib/calendar-date';

const FALLBACK_TIMEZONE = 'America/New_York';

/**
 * Cron endpoint: Send daily time entry reminders.
 * Should be called once per day (e.g., 4:00 PM local time) on weekdays.
 *
 * Iterates all active tenants and sends reminders to employees who have
 * NOT entered time for today.
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
  // Shared Resend budget: ≤ 2 sends/second for this cron (feature-plan-launch-blockers.md P1 §5).
  const sendThrottle = createSendThrottle();

  let skippedSeedRecipients = 0;

  // feature-plan-launch-blockers.md P6 §4: time budget, fair rotation, per-tenant failures isolated + reported.
  const sweep = await sweepTenants({
    name: 'daily-reminder',
    tenants: activeTenants,
    processTenant: async (tenant, { outOfTime, resumeAfter }) => {
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

      let lastDone: string | null = resumeAfter;
      for (const emp of allEmployees) {
        // Audit A10: the budget is checked before EVERY employee (a big tenant with nothing to send still costs time);
        // past the check, this employee is handled completely.
        if (outOfTime()) return { stoppedAfter: lastDone };
        lastDone = emp.id;
        if (usersWithEntries.has(emp.id)) continue;
        if (isSeedRecipient(emp.email)) { skippedSeedRecipients++; continue; } // P6 §4: demo domains we don't own

        const prefs = await db
          .select({ enabled: notificationPreferences.emailDailyReminder })
          .from(notificationPreferences)
          .where(eq(notificationPreferences.userId, emp.id));

        const enabled = prefs.length === 0 ? true : prefs[0].enabled;

        if (enabled) {
          await sendThrottle();
          const outcome = await sendDailyReminderEmail({
            employeeEmail: emp.email,
            employeeName: emp.fullName,
            todayDate: formatCalendarDate(today, 'dddd, MMM D, YYYY'),
            appUrl: tenantBaseUrl(tenant.slug),
          });
          if (outcome.ok) totalSent++;
          else if (outcome.reason === 'error') totalFailed++;
        }
      }
      return 'done';
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
  };
}
