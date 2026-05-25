'use server';

import { db } from '@/db';
import { timesheetPeriods, users, timesheetEntries } from '@/db/schema';
import { eq, and, inArray, gte, lt, sql } from 'drizzle-orm';
import { getSupervisedEmployeeIds } from '@/server/actions/supervisor-scope';
import { sendTimesheetSubmittedEmail, sendTimesheetApprovedEmail, sendTimesheetRejectedEmail } from '@/lib/email/send';
import { isNotificationEnabled } from '@/server/actions/notifications';
import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { getNumDaysInPeriod } from '@/lib/date-utils';

dayjs.extend(isSameOrAfter);

export type PeriodStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface PeriodInfo {
  id: string | null;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewComment: string | null;
}

/**
 * Get the period status for a specific user and period start date.
 * Returns draft if no record exists yet.
 */
export async function getPeriodStatus(userId: string, periodStart: Date): Promise<PeriodInfo> {
  const rows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, periodStart),
      )
    );

  if (rows.length === 0) {
    return {
      id: null,
      status: 'draft',
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
    };
  }

  const row = rows[0];
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    reviewComment: row.reviewComment,
  };
}

/**
 * Submit a timesheet period (employee certification).
 * Creates the period record if it doesn't exist, or updates status to 'submitted'.
 */
export async function submitPeriod(data: {
  userId: string;
  periodStart: Date;
  comment?: string;
}): Promise<PeriodInfo> {
  // Server-side validation: cannot submit before the last day of the period
  const numDays = getNumDaysInPeriod(data.periodStart);
  const periodEndDate = dayjs(data.periodStart).add(numDays - 1, 'day');
  if (!dayjs().isSameOrAfter(periodEndDate, 'day')) {
    throw new Error(`Cannot submit before the last day of the pay period (${periodEndDate.format('MMM D, YYYY')}).`);
  }

  // Server-side validation: cannot submit a completely empty timesheet
  const periodEndExclusive = dayjs(data.periodStart).add(numDays, 'day').toDate();
  const entryCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, data.userId),
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
        eq(timesheetPeriods.userId, data.userId),
        eq(timesheetPeriods.periodStart, data.periodStart),
      )
    );

  if (existing.length === 0) {
    // Create new period record
    const rows = await db.insert(timesheetPeriods).values({
      userId: data.userId,
      periodStart: data.periodStart,
      status: 'submitted',
      submittedAt: new Date(),
      submittedComment: data.comment,
    }).returning();

    return {
      id: rows[0].id,
      status: 'submitted',
      submittedAt: rows[0].submittedAt,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
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
  };

  // Fire-and-forget: notify supervisor(s) via email
  const periodEnd = dayjs(data.periodStart).add(getNumDaysInPeriod(data.periodStart) - 1, 'day');
  const periodLabel = `${dayjs(data.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, data.userId));

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
 * Approve a timesheet period (supervisor action).
 */
export async function approvePeriod(data: {
  periodId: string;
  reviewedBy: string;
  comment?: string;
}): Promise<void> {
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.id, data.periodId));

  if (existing.length === 0) throw new Error('Period not found');
  if (existing[0].status !== 'submitted') {
    throw new Error(`Cannot approve period with status "${existing[0].status}". Only submitted periods can be approved.`);
  }

  // Verify the reviewer has scope over this employee
  const reviewerRole = await getReviewerRole(data.reviewedBy);
  if (reviewerRole !== 'admin') {
    const scopedIds = await getSupervisedEmployeeIds(data.reviewedBy, reviewerRole);
    if (scopedIds !== 'all' && !scopedIds.includes(existing[0].userId)) {
      throw new Error('Unauthorized: You are not authorized to approve this employee\'s timesheet. You do not share any CLIN assignments.');
    }
  }

  await db.update(timesheetPeriods)
    .set({
      status: 'approved',
      reviewedAt: new Date(),
      reviewedBy: data.reviewedBy,
      reviewComment: data.comment ?? null,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, data.periodId));

  // Fire-and-forget: notify employee via email
  const period = existing[0];
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  const [reviewer] = await db
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, data.reviewedBy));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnApprove');
    if (enabled) {
      const periodEnd = dayjs(period.periodStart).add(getNumDaysInPeriod(period.periodStart) - 1, 'day');
      const periodLabel = `${dayjs(period.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

      sendTimesheetApprovedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        approvedBy: reviewer?.fullName ?? 'Supervisor',
        approvedAt: dayjs().format('MMM D, YYYY h:mm A'),
      }); // No await — fire-and-forget
    }
  }
}

/**
 * Reject a timesheet period (supervisor action).
 * Returns the period to 'draft' status so the employee can re-edit.
 */
export async function rejectPeriod(data: {
  periodId: string;
  reviewedBy: string;
  comment: string; // Required for rejections
}): Promise<void> {
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.id, data.periodId));

  if (existing.length === 0) throw new Error('Period not found');
  if (existing[0].status !== 'submitted') {
    throw new Error(`Cannot reject period with status "${existing[0].status}". Only submitted periods can be rejected.`);
  }

  // Verify the reviewer has scope over this employee
  const reviewerRole = await getReviewerRole(data.reviewedBy);
  if (reviewerRole !== 'admin') {
    const scopedIds = await getSupervisedEmployeeIds(data.reviewedBy, reviewerRole);
    if (scopedIds !== 'all' && !scopedIds.includes(existing[0].userId)) {
      throw new Error('Unauthorized: You are not authorized to reject this employee\'s timesheet. You do not share any CLIN assignments.');
    }
  }

  await db.update(timesheetPeriods)
    .set({
      status: 'rejected',
      reviewedAt: new Date(),
      reviewedBy: data.reviewedBy,
      reviewComment: data.comment,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, data.periodId));

  // Fire-and-forget: notify employee via email
  const period = existing[0];
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  const [reviewer] = await db
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, data.reviewedBy));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnReject');
    if (enabled) {
      const periodEnd = dayjs(period.periodStart).add(getNumDaysInPeriod(period.periodStart) - 1, 'day');
      const periodLabel = `${dayjs(period.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

      sendTimesheetRejectedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        rejectedBy: reviewer?.fullName ?? 'Supervisor',
        rejectedAt: dayjs().format('MMM D, YYYY h:mm A'),
        rejectionComment: data.comment,
      }); // No await — fire-and-forget
    }
  }
}

/**
 * Get all submitted timesheets pending review (for supervisors/admins).
 */
export async function getPendingApprovals(): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
}>> {
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
    .where(eq(timesheetPeriods.status, 'submitted'))
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}

/**
 * Get all timesheet periods that a supervisor is authorized to review.
 * Filters based on contract-based scope (shared CLIN assignments).
 *
 * @param scopedEmployeeIds - Array of employee IDs the supervisor can review, or 'all' for admins
 */
export async function getScopedPeriods(
  scopedEmployeeIds: string[] | 'all'
): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
}>> {
  if (scopedEmployeeIds === 'all') {
    // Admin — return all periods (existing behavior)
    return getAllPeriods();
  }

  if (scopedEmployeeIds.length === 0) {
    return []; // Supervisor has no employees in scope
  }

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
    .where(inArray(timesheetPeriods.userId, scopedEmployeeIds))
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}

/**
 * Get pending approvals scoped to a supervisor's employees.
 */
export async function getScopedPendingApprovals(
  scopedEmployeeIds: string[] | 'all'
): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
}>> {
  if (scopedEmployeeIds === 'all') {
    return getPendingApprovals();
  }

  if (scopedEmployeeIds.length === 0) {
    return [];
  }

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
    .where(
      and(
        eq(timesheetPeriods.status, 'submitted'),
        inArray(timesheetPeriods.userId, scopedEmployeeIds),
      )
    )
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}

/**
 * Get all timesheet periods for a supervisor to review (all statuses).
 */
async function getReviewerRole(userId: string): Promise<string> {
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  return user?.role ?? 'employee';
}

export async function getAllPeriods(): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
}>> {
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
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}
