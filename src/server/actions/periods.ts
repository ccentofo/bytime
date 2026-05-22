'use server';

import { db } from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
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

  return {
    id: rows[0].id,
    status: 'submitted',
    submittedAt: rows[0].submittedAt,
    reviewedAt: null,
    reviewedBy: null,
    reviewComment: null,
  };
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

  await db.update(timesheetPeriods)
    .set({
      status: 'approved',
      reviewedAt: new Date(),
      reviewedBy: data.reviewedBy,
      reviewComment: data.comment ?? null,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, data.periodId));
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

  await db.update(timesheetPeriods)
    .set({
      status: 'rejected',
      reviewedAt: new Date(),
      reviewedBy: data.reviewedBy,
      reviewComment: data.comment,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, data.periodId));
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
 * Get all timesheet periods for a supervisor to review (all statuses).
 */
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
