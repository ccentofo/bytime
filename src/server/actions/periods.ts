'use server';

import { getDb } from '@/db';
import { timesheetPeriods, users, timesheetEntries } from '@/db/schema';
import { eq, and, inArray, gte, lt, sql } from 'drizzle-orm';
import { requireSession, requireApprover, getEmployeeScope, assertCanAccessEmployee } from '@/lib/session';
import { getPeriodStatusFor, type PeriodInfo, type PeriodStatus } from '@/server/internal/periods';
import { getSupervisorScopeInfo } from '@/server/internal/supervisor-scope';
import { sendTimesheetSubmittedEmail, sendTimesheetApprovedEmail, sendTimesheetRejectedEmail } from '@/lib/email/send';
import { isNotificationEnabled } from '@/server/internal/notifications';
import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { getNumDaysInPeriod, getLastWeekdayInPeriod } from '@/lib/date-utils';
import { getEffectiveConfigAt } from '@/server/actions/pay-period-config';

dayjs.extend(isSameOrAfter);

export type { PeriodStatus, PeriodInfo };

/**
 * Get the period status for the session user and a given period start date.
 * Returns draft if no record exists yet.
 */
export async function getPeriodStatus(periodStart: Date): Promise<PeriodInfo> {
  const actor = await requireSession();
  return getPeriodStatusFor(actor.id, periodStart);
}

/**
 * Submit a timesheet period (employee certification) for the session user.
 * Creates the period record if it doesn't exist, or updates status to 'submitted'.
 */
export async function submitPeriod(data: {
  periodStart: Date;
  comment?: string;
  completeness?: unknown; // structured warnings snapshot from the client (advisory)
}): Promise<PeriodInfo> {
  const actor = await requireSession();
  const userId = actor.id;
  const db = await getDb();

  // Resolve the config that was in effect for this specific period
  const periodConfig = await getEffectiveConfigAt(data.periodStart);

  // Server-side validation: cannot submit before the last WEEKDAY of the period
  const lastWeekday = getLastWeekdayInPeriod(data.periodStart, periodConfig);
  const periodEndDate = dayjs(lastWeekday);
  if (!dayjs().isSameOrAfter(periodEndDate, 'day')) {
    throw new Error(`Cannot submit before the last day of the pay period (${periodEndDate.format('MMM D, YYYY')}).`);
  }

  // Server-side validation: cannot submit a completely empty timesheet
  const numDays = getNumDaysInPeriod(data.periodStart, periodConfig);
  const periodEndExclusive = dayjs(data.periodStart).add(numDays, 'day').toDate();
  const entryCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, data.periodStart),
        lt(timesheetEntries.entryDate, periodEndExclusive),
      )
    );

  if (Number(entryCount[0]?.count ?? 0) === 0) {
    throw new Error('Cannot submit an empty timesheet. Please enter your hours before submitting.');
  }

  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, data.periodStart),
      )
    );

  if (existing.length === 0) {
    // Create new period record — snapshot the effective config at this period's start date
    // (full config stored as audit record; periodConfig already resolved above)
    const snapshotNumDays = getNumDaysInPeriod(data.periodStart, periodConfig);

    const rows = await db.insert(timesheetPeriods).values({
      userId,
      periodStart: data.periodStart,
      status: 'submitted',
      submittedAt: new Date(),
      submittedComment: data.comment,
      periodType: periodConfig.periodType,
      periodNumDays: snapshotNumDays,
      completenessSnapshot: data.completeness ?? null,
    }).returning();

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

  const rows = await db.update(timesheetPeriods)
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

  // Fire-and-forget: notify supervisor(s) via email
  const periodEnd = dayjs(data.periodStart).add(getNumDaysInPeriod(data.periodStart, periodConfig) - 1, 'day');
  const periodLabel = `${dayjs(data.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));

  const supervisors = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.role, 'supervisor'));

  const admins = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.role, 'admin'));

  const reviewers = [...supervisors, ...admins];

  for (const reviewer of reviewers) {
    const enabled = await isNotificationEnabled(reviewer.id, 'emailOnSubmit');
    if (enabled && employee) {
      sendTimesheetSubmittedEmail({
        supervisorEmail: reviewer.email,
        supervisorName: reviewer.fullName,
        employeeName: employee.fullName,
        employeeEmail: employee.email,
        periodLabel,
        submittedAt: dayjs().format('MMM D, YYYY h:mm A'),
      }); // No await — fire-and-forget
    }
  }

  return result;
}

/**
 * Approve a timesheet period. Approver only, and only for an employee in scope.
 * An actor may never approve their own period (admins included).
 */
export async function approvePeriod(data: {
  periodId: string;
  comment?: string;
}): Promise<void> {
  const actor = await requireApprover();
  const db = await getDb();
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.id, data.periodId));

  if (existing.length === 0) throw new Error('Period not found');
  const period = existing[0];
  if (period.status !== 'submitted') {
    throw new Error(`Cannot approve period with status "${period.status}". Only submitted periods can be approved.`);
  }

  if (period.userId === actor.id) {
    throw new Error('Forbidden: You cannot approve your own timesheet.');
  }
  await assertCanAccessEmployee(actor, period.userId);

  await db.update(timesheetPeriods)
    .set({
      status: 'approved',
      reviewedAt: new Date(),
      reviewedBy: actor.id,
      reviewComment: data.comment ?? null,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, data.periodId));

  // Fire-and-forget: notify employee via email
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnApprove');
    if (enabled) {
      const periodEnd = dayjs(period.periodStart).add((period.periodNumDays ?? getNumDaysInPeriod(period.periodStart)) - 1, 'day');
      const periodLabel = `${dayjs(period.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

      sendTimesheetApprovedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        approvedBy: actor.fullName,
        approvedAt: dayjs().format('MMM D, YYYY h:mm A'),
      }); // No await — fire-and-forget
    }
  }
}

/**
 * Reject a timesheet period. Approver only, and only for an employee in scope.
 * Returns the period to 'draft' status so the employee can re-edit.
 * An actor may never reject their own period (admins included).
 */
export async function rejectPeriod(data: {
  periodId: string;
  comment: string; // Required for rejections
}): Promise<void> {
  const actor = await requireApprover();
  const db = await getDb();
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.id, data.periodId));

  if (existing.length === 0) throw new Error('Period not found');
  const period = existing[0];
  if (period.status !== 'submitted') {
    throw new Error(`Cannot reject period with status "${period.status}". Only submitted periods can be rejected.`);
  }

  if (period.userId === actor.id) {
    throw new Error('Forbidden: You cannot reject your own timesheet.');
  }
  await assertCanAccessEmployee(actor, period.userId);

  await db.update(timesheetPeriods)
    .set({
      status: 'rejected',
      reviewedAt: new Date(),
      reviewedBy: actor.id,
      reviewComment: data.comment,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, data.periodId));

  // Fire-and-forget: notify employee via email
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnReject');
    if (enabled) {
      const periodEnd = dayjs(period.periodStart).add((period.periodNumDays ?? getNumDaysInPeriod(period.periodStart)) - 1, 'day');
      const periodLabel = `${dayjs(period.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

      sendTimesheetRejectedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        rejectedBy: actor.fullName,
        rejectedAt: dayjs().format('MMM D, YYYY h:mm A'),
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
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
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
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt,
    })
    .from(timesheetPeriods)
    .innerJoin(users, eq(timesheetPeriods.userId, users.id))
    .where(whereClause)
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}

/**
 * Get pending (submitted) approvals, scoped to the approver's employees (or all, for admins).
 */
export async function getScopedPendingApprovals(): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
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

  return rows;
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
