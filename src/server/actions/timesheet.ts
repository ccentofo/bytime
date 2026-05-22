'use server';

import { db } from '@/db';
import { timesheetEntries, userAssignments, clins, contracts } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';

/**
 * Get the charge codes (CLINs) assigned to a specific user.
 * Returns data shaped to match the ChargeCode interface.
 */
export async function getChargeCodesForUser(userId: string): Promise<ChargeCode[]> {
  const rows = await db
    .select({
      id: clins.id,
      projectName: contracts.name,
      clin: clins.clinNumber,
      description: clins.description,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(
      and(
        eq(userAssignments.userId, userId),
        eq(userAssignments.isActive, true),
        eq(clins.status, 'active'),
        eq(contracts.status, 'active'),
      )
    )
    .orderBy(contracts.name, clins.clinNumber);

  return rows.map((r) => ({
    id: r.id,
    projectName: r.projectName,
    clin: r.clin,
    description: r.description ?? '',
  }));
}

/**
 * Get timesheet entries for a user in a specific pay period.
 * Returns the LATEST revision for each (clinId, entryDate) pair.
 * Shapes data into TimesheetEntry[] (one per charge code, with hours array).
 */
export async function getTimesheetEntries(
  userId: string,
  periodStart: Date,
  chargeCodes: ChargeCode[]
): Promise<TimesheetEntry[]> {
  const numDays = getNumDaysInPeriod(periodStart);
  const start = dayjs(periodStart);
  const endDate = start.add(numDays, 'day');

  // Get all entries for this user in this period
  const rows = await db
    .select({
      clinId: timesheetEntries.clinId,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, start.toDate()),
        lt(timesheetEntries.entryDate, endDate.toDate()),
      )
    )
    .orderBy(timesheetEntries.clinId, timesheetEntries.entryDate, desc(timesheetEntries.revisionNumber));

  // Build a map of latest revision per (clinId, dateIndex)
  // Key: "clinId-dayIndex", Value: hours
  const latestHours = new Map<string, number>();
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const key = `${row.clinId}-${dayIndex}`;
    // Since we ordered by revisionNumber DESC, the first occurrence is the latest
    if (!latestHours.has(key)) {
      latestHours.set(key, parseFloat(row.hours));
    }
  }

  // Build TimesheetEntry[] for each charge code
  return chargeCodes.map((cc) => {
    const hours: number[] = [];
    for (let i = 0; i < numDays; i++) {
      const key = `${cc.id}-${i}`;
      hours.push(latestHours.get(key) ?? 0);
    }
    return { chargeCodeId: cc.id, hours };
  });
}

/**
 * Get revision numbers for all cells in a period.
 * Returns a map of "clinId-dayIndex" → maxRevisionNumber.
 */
export async function getRevisionMap(
  userId: string,
  periodStart: Date,
  numDays: number
): Promise<Record<string, number>> {
  const start = dayjs(periodStart);
  const endDate = start.add(numDays, 'day');

  const rows = await db
    .select({
      clinId: timesheetEntries.clinId,
      entryDate: timesheetEntries.entryDate,
      maxRevision: sql<number>`MAX(${timesheetEntries.revisionNumber})`,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, start.toDate()),
        lt(timesheetEntries.entryDate, endDate.toDate()),
      )
    )
    .groupBy(timesheetEntries.clinId, timesheetEntries.entryDate);

  const revisionMap: Record<string, number> = {};
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const key = `${row.clinId}-${dayIndex}`;
    revisionMap[key] = row.maxRevision;
  }
  return revisionMap;
}

/**
 * Batch save multiple timesheet entries in a single call.
 * All entries in the batch share the same changeReasonCode and comment
 * (if they are edits to previously-saved cells).
 */
export async function saveTimesheetBatch(data: {
  userId: string;
  periodStart: Date;
  cells: Array<{
    clinId: string;
    dayIndex: number;
    hours: number;
    isEdit: boolean;
    isLateEntry: boolean;
  }>;
  changeReasonCode?: string;
  comment?: string;
}): Promise<Record<string, number>> {
  const start = dayjs(data.periodStart);
  const today = dayjs().startOf('day');
  const newRevisions: Record<string, number> = {};

  // Server-side guard: reject any entries for future dates
  for (const cell of data.cells) {
    const entryDate = start.add(cell.dayIndex, 'day');
    if (entryDate.isAfter(today, 'day')) {
      throw new Error(`Cannot save hours for future date: ${entryDate.format('MMM D, YYYY')}`);
    }
  }

  for (const cell of data.cells) {
    const entryDate = start.add(cell.dayIndex, 'day').toDate();

    // Get current max revision
    const existing = await db
      .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
      .from(timesheetEntries)
      .where(
        and(
          eq(timesheetEntries.userId, data.userId),
          eq(timesheetEntries.clinId, cell.clinId),
          eq(timesheetEntries.entryDate, entryDate),
        )
      );

    const nextRevision = (existing[0]?.maxRevision ?? 0) + 1;

    await db.insert(timesheetEntries).values({
      userId: data.userId,
      clinId: cell.clinId,
      entryDate,
      hours: cell.hours.toString(),
      revisionNumber: nextRevision,
      changeReasonCode: (cell.isEdit || cell.isLateEntry) ? (data.changeReasonCode ?? undefined) : undefined,
      comment: (cell.isEdit || cell.isLateEntry) ? (data.comment ?? undefined) : undefined,
      createdBy: data.userId,
    });

    const key = `${cell.clinId}-${cell.dayIndex}`;
    newRevisions[key] = nextRevision;
  }

  return newRevisions;
}

/**
 * Get a read-only view of a user's timesheet for supervisor review.
 * Returns charge codes and entries for the specified user and period.
 */
export async function getTimesheetForReview(
  userId: string,
  periodStart: Date
): Promise<{ chargeCodes: ChargeCode[]; entries: TimesheetEntry[] }> {
  const chargeCodes = await getChargeCodesForUser(userId);
  const entries = await getTimesheetEntries(userId, periodStart, chargeCodes);
  return { chargeCodes, entries };
}

/**
 * Save a single timesheet entry (append-only — creates a new revision).
 */
export async function saveTimesheetEntry(data: {
  userId: string;
  clinId: string;
  entryDate: Date;
  hours: number;
  changeReasonCode?: string;
  comment?: string;
}): Promise<void> {
  // Find the current max revision for this (userId, clinId, entryDate)
  const existing = await db
    .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, data.userId),
        eq(timesheetEntries.clinId, data.clinId),
        eq(timesheetEntries.entryDate, data.entryDate),
      )
    );

  const nextRevision = (existing[0]?.maxRevision ?? 0) + 1;

  await db.insert(timesheetEntries).values({
    userId: data.userId,
    clinId: data.clinId,
    entryDate: data.entryDate,
    hours: data.hours.toString(),
    revisionNumber: nextRevision,
    changeReasonCode: nextRevision > 1 ? (data.changeReasonCode ?? 'CORRECTION') : undefined,
    comment: data.comment,
    createdBy: data.userId,
  });
}
