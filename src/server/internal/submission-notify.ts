import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import { sendTimesheetSubmittedEmail } from '@/lib/email/send';
import { scheduleEmail } from '@/lib/email/schedule';
import { getTenantSlug } from '@/lib/tenant/context';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { addDays, formatCalendarDate, formatInstant, type CalendarDate } from '@/lib/calendar-date';
import { existingPeriodLength } from './pay-period-config';
import { getWorkspaceTimezone } from './workspace-settings';
import { isNotificationEnabled } from './notifications';
import { DESIGNEE_LOST_NOTE, eligibleApprovers, loadApprovalFacts, type ReroutedApproval } from './approval-rules';

/**
 * "Timesheet waiting for approval" emails (feature-plan-certified-outputs.md C2). INTERNAL: callers authorize first.
 * Recipients are exactly the users for whom canApprove(recipient, employee) holds — admins, the effective designee, and
 * CLIN-sharing supervisors when the employee is employee-role — never the submitter, each only if they opted in
 * (emailOnSubmit). Sends run after the response (scheduleEmail), with links to this workspace's own host.
 */
export async function notifySubmissionRecipients(opts: {
  employeeId: string;
  periodStart: CalendarDate;
  numDays: number;
  /** Restrict to these recipients (re-routing); default: every eligible approver. */
  only?: string[];
  /** An extra line in the email (ruling Q8: the designated approver is no longer available). */
  note?: string;
  /** When the timesheet was SUBMITTED (fix round 1, F15) — a re-route email must not print the re-route time. */
  submittedAt: Date | null;
}): Promise<void> {
  const db = await getDb();
  const facts = await loadApprovalFacts(db);
  const eligible = new Set(eligibleApprovers(facts, opts.employeeId));
  const candidateIds = (opts.only ?? [...eligible]).filter((id) => eligible.has(id) && id !== opts.employeeId);
  if (candidateIds.length === 0) return;

  const [employee] = await db.select({ fullName: users.fullName, email: users.email }).from(users).where(eq(users.id, opts.employeeId));
  if (!employee) return;
  const people = await db.select({ id: users.id, fullName: users.fullName, email: users.email }).from(users).where(inArray(users.id, candidateIds));
  const recipients: typeof people = [];
  for (const p of people) if (await isNotificationEnabled(p.id, 'emailOnSubmit')) recipients.push(p);
  if (recipients.length === 0) return;

  const periodEnd = addDays(opts.periodStart, opts.numDays - 1);
  const periodLabel = `${formatCalendarDate(opts.periodStart, 'MMM D')} – ${formatCalendarDate(periodEnd, 'MMM D, YYYY')}`;
  const submittedAt = opts.submittedAt ? formatInstant(opts.submittedAt, await getWorkspaceTimezone(), 'MMM D, YYYY h:mm A') : 'an unknown time';
  const appUrl = tenantBaseUrl(await getTenantSlug());
  scheduleEmail('timesheet-submitted', async () => {
    for (const reviewer of recipients) {
      await sendTimesheetSubmittedEmail({
        supervisorEmail: reviewer.email,
        supervisorName: reviewer.fullName,
        employeeName: employee.fullName,
        employeeEmail: employee.email,
        periodLabel,
        submittedAt,
        appUrl,
        ...(opts.note ? { note: opts.note } : {}),
      });
    }
  });
}

/**
 * CO-D19 re-routing: after an approver-rule change committed, email the waiting timesheets' NEWLY eligible approvers
 * (src/server/internal/approval-rules.ts newlyEligible). Never throws — the change is already committed.
 */
export async function notifyReroutedApprovals(list: ReroutedApproval[]): Promise<void> {
  if (list.length === 0) return;
  try {
    const db = await getDb();
    const periods = await db.select({ id: timesheetPeriods.id, periodStart: timesheetPeriods.periodStart, periodNumDays: timesheetPeriods.periodNumDays, submittedAt: timesheetPeriods.submittedAt })
      .from(timesheetPeriods).where(inArray(timesheetPeriods.id, list.map((l) => l.periodId)));
    const byId = new Map(periods.map((p) => [p.id, p]));
    for (const item of list) {
      const p = byId.get(item.periodId);
      if (!p) continue;
      const start = p.periodStart as CalendarDate;
      await notifySubmissionRecipients({
        employeeId: item.userId, periodStart: start, numDays: await existingPeriodLength(db, start, p.periodNumDays),
        only: item.recipients, ...(item.designeeLost ? { note: DESIGNEE_LOST_NOTE } : {}), submittedAt: p.submittedAt,
      });
    }
  } catch (err) {
    console.error('Re-routed approval notification failed:', err);
  }
}
