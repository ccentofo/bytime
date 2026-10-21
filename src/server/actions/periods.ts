'use server';

import { getDb, getDbForWrite } from '@/db';
import { timesheetPeriods, users, timesheetEntries, periodEvents } from '@/db/schema';
import { eq, and, inArray, gte, lt, sql } from 'drizzle-orm';
import { requireSession, requireApprover, requireApproverFresh, getEmployeeScope, assertCanAccessEmployee, AuthorizationError } from '@/lib/session';
import { getPeriodStatusFor, resolvePeriod, type PeriodInfo, type PeriodStatus } from '@/server/internal/periods';
import { getSupervisorScopeInfo, getSupervisedEmployeeIds } from '@/server/internal/supervisor-scope';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { existingPeriodLength, loadScheduleResolver } from '@/server/internal/pay-period-config';
import { sendTimesheetSubmittedEmail, sendTimesheetApprovedEmail, sendTimesheetRejectedEmail } from '@/lib/email/send';
import { isNotificationEnabled } from '@/server/internal/notifications';
import { getLastWeekdayInPeriod } from '@/lib/date-utils';
import { addDays, formatInstant, isBefore, formatCalendarDate, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';

/**
 * Get the period status for the session user and a given period start date.
 * Returns draft if no record exists yet.
 */
export async function getPeriodStatus(periodStart: CalendarDate): Promise<PeriodInfo> {
  const actor = await requireSession();
  return getPeriodStatusFor(actor.id, parseCalendarDate(periodStart));
}

/** Resolve a period's day count from its own stored snapshot, falling back to its config. */
async function resolvePeriodNumDays(periodStart: CalendarDate, periodNumDays: number | null): Promise<number> {
  return existingPeriodLength(await getDb(), periodStart, periodNumDays);
}

/**
 * The workspace's "today" and IANA timezone, for the client. D4: the client does no clock math
 * of its own — every late/future-date flag and period landing decision derives from this,
 * refreshed periodically so a tab left open overnight rolls over correctly.
 */
export async function getWorkspaceContext(): Promise<{ today: CalendarDate; timezone: string }> {
  await requireSession();
  const timezone = await getWorkspaceTimezone();
  return { today: await getWorkspaceToday(), timezone };
}

export interface PeriodOption {
  start: CalendarDate;
  numDays: number;
  label: string;
}

/**
 * List period options around a given day — `before` periods back, `after` periods forward,
 * plus the period containing `aroundDay` itself. Each is resolved under ITS OWN effective
 * config (via the same two-sided snap as getNeighborPeriod), so the list is correct across a
 * pay-schedule change instead of assuming every period shares one schedule. D4: the client uses
 * this instead of computing period boundaries itself (fixes the selector's history across
 * schedule changes and the hard-coded semimonthly reports dropdown).
 */
const MAX_PERIOD_OPTIONS_EACH_WAY = 60;

export async function getPeriodOptions(aroundDay: CalendarDate, before: number, after: number): Promise<PeriodOption[]> {
  await requireSession();
  const day = parseCalendarDate(aroundDay);
  // Bounded: this is a public endpoint, and each step is work on the server.
  for (const [name, n] of [['before', before], ['after', after]] as const) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_PERIOD_OPTIONS_EACH_WAY) {
      throw new Error(`${name} must be an integer from 0 to ${MAX_PERIOD_OPTIONS_EACH_WAY}.`);
    }
  }

  // One query for the whole schedule history, then everything resolves in memory.
  const schedule = await loadScheduleResolver(await getDb());
  const toOption = (p: { start: CalendarDate; numDays: number }): PeriodOption => ({
    start: p.start,
    numDays: p.numDays,
    label: `${formatCalendarDate(p.start, 'MMM D')} – ${formatCalendarDate(addDays(p.start, p.numDays - 1), 'MMM D, YYYY')}`,
  });

  const center = schedule.periodContaining(day);
  const options: PeriodOption[] = [toOption(center)];

  let cursor = center;
  for (let i = 0; i < before; i++) {
    cursor = schedule.neighbor(cursor.start, 'prev');
    options.unshift(toOption(cursor));
  }
  cursor = center;
  for (let i = 0; i < after; i++) {
    cursor = schedule.neighbor(cursor.start, 'next');
    options.push(toOption(cursor));
  }

  return options;
}

/**
 * Email the reviewers of a just-submitted period: active admins plus active supervisors whose
 * scope includes the submitter, never the submitter, each only if they opted in (emailOnSubmit).
 * Called on both the first submission and a re-submission. Sends are fire-and-forget.
 */
async function notifyReviewersOfSubmission(userId: string, periodStart: CalendarDate, numDays: number): Promise<void> {
  const periodEnd = addDays(periodStart, numDays - 1);
  const periodLabel = `${formatCalendarDate(periodStart, 'MMM D')} – ${formatCalendarDate(periodEnd, 'MMM D, YYYY')}`;
  const submittedAt = formatInstant(new Date(), await getWorkspaceTimezone(), 'MMM D, YYYY h:mm A');
  const db = await getDb();

  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));

  // R2-10: only ACTIVE reviewers, and only supervisors whose scope actually includes this
  // submitter (sharing an active CLIN assignment) — previously every supervisor in the tenant
  // was notified regardless of scope or active status, leaking who's submitting to people with
  // no business reason to know.
  const allSupervisors = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.role, 'supervisor'), eq(users.isActive, true)));

  const inScopeSupervisors: typeof allSupervisors = [];
  for (const supervisor of allSupervisors) {
    const scope = await getSupervisedEmployeeIds(supervisor.id, 'supervisor');
    if (scope.includes(userId)) inScopeSupervisors.push(supervisor);
  }

  const admins = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));

  // Never notify the submitter about their own submission (e.g. an admin's own timesheet).
  const reviewers = [...inScopeSupervisors, ...admins].filter((r) => r.id !== userId);

  for (const reviewer of reviewers) {
    const enabled = await isNotificationEnabled(reviewer.id, 'emailOnSubmit');
    if (enabled && employee) {
      sendTimesheetSubmittedEmail({
        supervisorEmail: reviewer.email,
        supervisorName: reviewer.fullName,
        employeeName: employee.fullName,
        employeeEmail: employee.email,
        periodLabel,
        submittedAt,
      }); // No await — fire-and-forget
    }
  }

}

/**
 * Submit a timesheet period (employee certification) for the session user.
 * Creates the period record if it doesn't exist, or updates status to 'submitted'.
 */
export async function submitPeriod(data: {
  periodStart: CalendarDate;
  comment?: string;
  completeness?: unknown; // structured warnings snapshot from the client (advisory)
}): Promise<PeriodInfo> {
  const actor = await requireSession();
  const userId = actor.id;
  const db = await getDbForWrite();
  const periodStart = parseCalendarDate(data.periodStart);

  // Must be a real period start (same rule as saveTimesheetBatch), so a submission can't
  // certify — and lock — an arbitrary date range. Also resolves the config this period
  // belongs to (the new one, for the first period of a schedule change).
  const { config: periodConfig, numDays } = await resolvePeriod(periodStart);

  // Server-side validation: cannot submit before the last WEEKDAY of the period, per the
  // WORKSPACE's today (never the browser's — a user could spoof their clock to submit early).
  const lastWeekday = getLastWeekdayInPeriod(periodStart, periodConfig);
  const today = await getWorkspaceToday();
  if (isBefore(today, lastWeekday)) {
    throw new Error(`Cannot submit before the last day of the pay period (${formatCalendarDate(lastWeekday, 'MMM D, YYYY')}).`);
  }

  // Server-side validation: cannot submit a completely empty timesheet
  const periodEndExclusive = addDays(periodStart, numDays);
  const entryCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, periodStart),
        lt(timesheetEntries.entryDate, periodEndExclusive),
      )
    );

  if (Number(entryCount[0]?.count ?? 0) === 0) {
    throw new Error('Cannot submit an empty timesheet. Please enter your hours before submitting.');
  }

  // periodStart is now an exact calendar day (a `date` column) — an exact match finds a
  // resubmission regardless of what time of day it's sent, with no window needed.
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, periodStart),
      )
    );

  if (existing.length === 0) {
    // Create new period record — snapshot the effective config at this period's start date
    // (full config stored as audit record; periodConfig already resolved above)
    const snapshotNumDays = numDays;

    const rows = await db.transaction(async (tx) => {
      const inserted = await tx.insert(timesheetPeriods).values({
        userId,
        periodStart,
        status: 'submitted',
        submittedAt: new Date(),
        submittedComment: data.comment,
        periodType: periodConfig.periodType,
        periodNumDays: snapshotNumDays,
        completenessSnapshot: data.completeness ?? null,
      }).returning();
      // T8/R11: append-only approval history, written in the same transaction as the period change.
      await tx.insert(periodEvents).values({
        periodId: inserted[0].id, userId, event: 'submitted', actorId: userId,
        comment: data.comment ?? null, completenessSnapshot: data.completeness ?? null,
      });
      return inserted;
    });

    // The submission is already committed; a notification failure must not report it as failed.
    await notifyReviewersOfSubmission(userId, periodStart, snapshotNumDays).catch((err) => console.error('Submission notification failed:', err));

    return {
      id: rows[0].id,
      status: 'submitted',
      submittedAt: rows[0].submittedAt,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
      periodType: rows[0].periodType ?? null,
      periodNumDays: rows[0].periodNumDays ?? null,
    };
  }

  // Update existing record
  const row = existing[0];
  if (row.status !== 'draft' && row.status !== 'rejected') {
    throw new Error(`Cannot submit period with status "${row.status}". Only draft or rejected periods can be submitted.`);
  }

  const rows = await db.transaction(async (tx) => {
    const updated = await tx.update(timesheetPeriods)
      .set({
        status: 'submitted',
        submittedAt: new Date(),
        submittedComment: data.comment,
        reviewedAt: null,
        reviewedBy: null,
        reviewComment: null,
        completenessSnapshot: data.completeness ?? null,
        updatedAt: new Date(),
      })
      .where(eq(timesheetPeriods.id, row.id))
      .returning();
    // T8/R11: append-only approval history, written in the same transaction as the period change.
    await tx.insert(periodEvents).values({
      periodId: row.id, userId, event: 'submitted', actorId: userId,
      comment: data.comment ?? null, completenessSnapshot: data.completeness ?? null,
    });
    return updated;
  });

  const result = {
    id: rows[0].id,
    status: 'submitted' as PeriodStatus,
    submittedAt: rows[0].submittedAt,
    reviewedAt: null,
    reviewedBy: null,
    reviewComment: null,
    periodType: rows[0].periodType ?? null,
    periodNumDays: rows[0].periodNumDays ?? null,
  };

  // The submission is already committed; a notification failure must not report it as failed.
  await notifyReviewersOfSubmission(userId, periodStart, numDays).catch((err) => console.error('Submission notification failed:', err));

  return result;
}

/**
 * Approve a timesheet period. Approver only, and only for an employee in scope.
 * Admins may approve their own period (§0); supervisors and employees may not.
 */
export async function approvePeriod(data: {
  periodId: string;
  comment?: string;
}): Promise<void> {
  const actor = await requireApproverFresh();
  const db = await getDbForWrite();
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.id, data.periodId));

  if (existing.length === 0) throw new Error('Period not found');
  const period = existing[0];

  // R2-7 (§0, locked product decision): admins may approve their own timesheet; supervisors
  // and employees still may not.
  if (period.userId === actor.id && actor.role !== 'admin') {
    // Their own period, so there's nothing to mask: say plainly why it's refused.
    throw new AuthorizationError('forbidden', 'Forbidden: You cannot approve your own timesheet.');
  }

  // R2-12: scope check immediately after loading the period, before anything about its status
  // is disclosed — an out-of-scope period must look exactly like a missing one. (For a self
  // approval this trivially passes: assertCanAccessEmployee always allows actor.id === employeeId.)
  try {
    await assertCanAccessEmployee(actor, period.userId);
  } catch {
    throw new Error('Period not found');
  }

  if (period.status !== 'submitted') {
    throw new Error(`Cannot approve period with status "${period.status}". Only submitted periods can be approved.`);
  }

  await db.transaction(async (tx) => {
    await tx.update(timesheetPeriods)
      .set({
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: actor.id,
        reviewComment: data.comment ?? null,
        updatedAt: new Date(),
      })
      .where(eq(timesheetPeriods.id, data.periodId));
    // T8/R11: append-only approval history, written in the same transaction as the period change.
    await tx.insert(periodEvents).values({
      periodId: data.periodId, userId: period.userId, event: 'approved', actorId: actor.id,
      comment: data.comment ?? null, completenessSnapshot: period.completenessSnapshot ?? null,
    });
  });

  // Fire-and-forget: notify employee via email
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnApprove');
    if (enabled) {
      const periodStart = period.periodStart as CalendarDate;
      const numDays = await resolvePeriodNumDays(periodStart, period.periodNumDays);
      const periodEnd = addDays(periodStart, numDays - 1);
      const periodLabel = `${formatCalendarDate(periodStart, 'MMM D')} – ${formatCalendarDate(periodEnd, 'MMM D, YYYY')}`;

      sendTimesheetApprovedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        approvedBy: actor.fullName,
        approvedAt: formatInstant(new Date(), await getWorkspaceTimezone(), 'MMM D, YYYY h:mm A'),
      }); // No await — fire-and-forget
    }
  }
}

/**
 * Reject a timesheet period. Approver only, and only for an employee in scope.
 * Sets status to 'rejected' so the employee can re-edit and resubmit.
 * Admins may reject their own period (§0); supervisors and employees may not.
 */
export async function rejectPeriod(data: {
  periodId: string;
  comment: string; // Required for rejections
}): Promise<void> {
  const actor = await requireApproverFresh();
  const db = await getDbForWrite();
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.id, data.periodId));

  if (existing.length === 0) throw new Error('Period not found');
  const period = existing[0];

  // R2-7 (§0, locked product decision): admins may reject their own timesheet; supervisors
  // and employees still may not.
  if (period.userId === actor.id && actor.role !== 'admin') {
    throw new AuthorizationError('forbidden', 'Forbidden: You cannot reject your own timesheet.');
  }

  // R2-12: scope check immediately after loading the period, before anything about its status
  // is disclosed — an out-of-scope period must look exactly like a missing one.
  try {
    await assertCanAccessEmployee(actor, period.userId);
  } catch {
    throw new Error('Period not found');
  }

  if (period.status !== 'submitted') {
    throw new Error(`Cannot reject period with status "${period.status}". Only submitted periods can be rejected.`);
  }

  await db.transaction(async (tx) => {
    await tx.update(timesheetPeriods)
      .set({
        status: 'rejected',
        reviewedAt: new Date(),
        reviewedBy: actor.id,
        reviewComment: data.comment,
        updatedAt: new Date(),
      })
      .where(eq(timesheetPeriods.id, data.periodId));
    // T8/R11: append-only approval history, written in the same transaction as the period change.
    await tx.insert(periodEvents).values({
      periodId: data.periodId, userId: period.userId, event: 'rejected', actorId: actor.id,
      comment: data.comment, completenessSnapshot: period.completenessSnapshot ?? null,
    });
  });

  // Fire-and-forget: notify employee via email
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnReject');
    if (enabled) {
      const periodStart = period.periodStart as CalendarDate;
      const numDays = await resolvePeriodNumDays(periodStart, period.periodNumDays);
      const periodEnd = addDays(periodStart, numDays - 1);
      const periodLabel = `${formatCalendarDate(periodStart, 'MMM D')} – ${formatCalendarDate(periodEnd, 'MMM D, YYYY')}`;

      sendTimesheetRejectedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        rejectedBy: actor.fullName,
        rejectedAt: formatInstant(new Date(), await getWorkspaceTimezone(), 'MMM D, YYYY h:mm A'),
        rejectionComment: data.comment,
      }); // No await — fire-and-forget
    }
  }
}

/**
 * Get all timesheet periods, scoped to the approver's employees (or all, for admins).
 */
export async function getScopedPeriods(): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: CalendarDate;
  periodNumDays: number;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}>> {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  const db = await getDb();

  const whereClause = scope === 'all' ? undefined : inArray(timesheetPeriods.userId, scope);
  if (scope !== 'all' && scope.length === 0) return [];

  const rows = await db
    .select({
      id: timesheetPeriods.id,
      userId: timesheetPeriods.userId,
      userName: users.fullName,
      userEmail: users.email,
      periodStart: timesheetPeriods.periodStart,
      periodNumDays: timesheetPeriods.periodNumDays,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt,
      // R2-7: exposed so the UI can render "Self-approved" when reviewedBy === userId.
      reviewedBy: timesheetPeriods.reviewedBy,
    })
    .from(timesheetPeriods)
    .innerJoin(users, eq(timesheetPeriods.userId, users.id))
    .where(whereClause)
    .orderBy(timesheetPeriods.submittedAt);

  const resolvedRows = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      periodNumDays: await resolvePeriodNumDays(row.periodStart as CalendarDate, row.periodNumDays),
    }))
  );

  return resolvedRows as Array<{
    id: string; userId: string; userName: string; userEmail: string; periodStart: CalendarDate;
    periodNumDays: number; status: PeriodStatus; submittedAt: Date | null; reviewedAt: Date | null; reviewedBy: string | null;
  }>;
}

/**
 * Get pending (submitted) approvals, scoped to the approver's employees (or all, for admins).
 */
export async function getScopedPendingApprovals(): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: CalendarDate;
  status: PeriodStatus;
  submittedAt: Date | null;
}>> {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  const db = await getDb();

  if (scope !== 'all' && scope.length === 0) return [];

  const whereClause = scope === 'all'
    ? eq(timesheetPeriods.status, 'submitted')
    : and(eq(timesheetPeriods.status, 'submitted'), inArray(timesheetPeriods.userId, scope));

  const rows = await db
    .select({
      id: timesheetPeriods.id,
      userId: timesheetPeriods.userId,
      userName: users.fullName,
      userEmail: users.email,
      periodStart: timesheetPeriods.periodStart,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
    })
    .from(timesheetPeriods)
    .innerJoin(users, eq(timesheetPeriods.userId, users.id))
    .where(whereClause)
    .orderBy(timesheetPeriods.submittedAt);

  return rows as Array<{
    id: string; userId: string; userName: string; userEmail: string; periodStart: CalendarDate;
    status: PeriodStatus; submittedAt: Date | null;
  }>;
}

/**
 * Get the session user's own approval-scope info (contract/CLIN/employee counts), for the
 * Approvals page banner. Supervisors only — admins have no "scope" to summarize.
 */
export async function getMyScopeInfo(): Promise<{
  assignedContractCount: number;
  assignedClinCount: number;
  supervisedEmployeeCount: number;
} | null> {
  const actor = await requireApprover();
  if (actor.role !== 'supervisor') return null;
  return getSupervisorScopeInfo(actor.id);
}
