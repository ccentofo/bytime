'use server';

import { db } from '@/db';
import { timesheetEntries, userAssignments, clins, contracts, slins, indirectChargeCodes } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { getNumDaysInPeriod, getPeriodStartForDate } from '@/lib/date-utils';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';
import { validateUUID, validateHours } from '@/lib/validation';
import { getPeriodStatus } from '@/server/actions/periods';

/**
 * Validate that a user has an active assignment to a specific CLIN.
 * Throws an error if the assignment does not exist.
 * This enforces DCAA RBAC: employees can only charge to authorized CLINs.
 */
async function validateClinAssignment(userId: string, clinId: string): Promise<void> {
  const assignment = await db
    .select({ id: userAssignments.id })
    .from(userAssignments)
    .where(
      and(
        eq(userAssignments.userId, userId),
        eq(userAssignments.clinId, clinId),
        eq(userAssignments.isActive, true),
      )
    )
    .limit(1);

  if (assignment.length === 0) {
    throw new Error(`Unauthorized: You are not assigned to CLIN ${clinId}. Cannot save timesheet entry.`);
  }
}

/**
 * Assert that a user's period is editable (draft or rejected).
 * Throws if the period has been certified (submitted) or approved.
 * This enforces DCAA audit-trail integrity: certified timesheets are immutable.
 */
async function assertPeriodEditable(userId: string, periodStart: Date): Promise<void> {
  const info = await getPeriodStatus(userId, periodStart);
  if (info.status !== 'draft' && info.status !== 'rejected') {
    throw new Error(
      `Cannot modify a ${info.status} timesheet. This period has been certified and is locked. ` +
      `If a correction is required, the supervisor must reject the period first.`
    );
  }
}

/**
 * Get the charge codes (CLINs) assigned to a specific user, plus active indirect codes.
 * Returns data shaped to match the ChargeCode interface.
 */
export async function getChargeCodesForUser(userId: string): Promise<ChargeCode[]> {
  // Get direct charge codes (CLINs from user assignments)
  const directRows = await db
    .select({
      id: clins.id,
      projectName: contracts.name,
      clin: clins.clinNumber,
      description: clins.description,
      slinId: userAssignments.slinId,
      slinNumber: slins.slinNumber,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(userAssignments.slinId, slins.id))
    .where(
      and(
        eq(userAssignments.userId, userId),
        eq(userAssignments.isActive, true),
        eq(clins.status, 'active'),
        eq(contracts.status, 'active'),
      )
    )
    .orderBy(contracts.name, clins.clinNumber);

  const directCodes: ChargeCode[] = directRows.map((r) => ({
    id: r.id,
    projectName: r.projectName,
    clin: r.clin,
    description: r.description ?? '',
    slinId: r.slinId ?? undefined,
    slinNumber: r.slinNumber ?? undefined,
    isIndirect: false,
  }));

  // Get indirect charge codes (available to all active employees)
  const indirectRows = await db
    .select()
    .from(indirectChargeCodes)
    .where(
      and(
        eq(indirectChargeCodes.isActive, true),
        eq(indirectChargeCodes.availableToAll, true),
      )
    )
    .orderBy(indirectChargeCodes.category, indirectChargeCodes.code);

  const CATEGORY_LABELS: Record<string, string> = {
    overhead: 'Overhead',
    ga: 'G&A',
    irad: 'IR&D',
    bp: 'Bid & Proposal',
    leave: 'Leave',
    unallowable: 'Unallowable',
  };

  const indirectCodes: ChargeCode[] = indirectRows.map((r) => ({
    id: r.id,
    projectName: CATEGORY_LABELS[r.category] ?? r.category,
    clin: r.code,
    description: r.description ?? r.name,
    isIndirect: true,
    indirectCategory: r.category,
  }));

  // Return direct codes first, then indirect codes
  return [...directCodes, ...indirectCodes];
}

/**
 * Get timesheet entries for a user in a specific pay period.
 * Returns the LATEST revision for each (clinId/indirectCodeId, entryDate) pair.
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
      indirectCodeId: timesheetEntries.indirectCodeId,
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

  // Build a map of latest revision per (clinId or indirectCodeId, dateIndex)
  const latestHours = new Map<string, number>();
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const entryId = row.clinId ?? row.indirectCodeId ?? '';
    const key = `${entryId}-${dayIndex}`;
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
 * Returns a map of "clinId/indirectCodeId-dayIndex" → maxRevisionNumber.
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
      indirectCodeId: timesheetEntries.indirectCodeId,
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
    .groupBy(timesheetEntries.clinId, timesheetEntries.indirectCodeId, timesheetEntries.entryDate);

  const revisionMap: Record<string, number> = {};
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const entryId = row.clinId ?? row.indirectCodeId ?? '';
    const key = `${entryId}-${dayIndex}`;
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
    clinId?: string;          // set for direct entries
    slinId?: string;
    indirectCodeId?: string;  // set for indirect entries
    dayIndex: number;
    hours: number;
    isEdit: boolean;
    isLateEntry: boolean;
    expectedRevision?: number; // Client's last known revision for this cell (0 = never saved)
  }>;
  changeReasonCode?: string;
  comment?: string;
  skipConflictCheck?: boolean; // Set to true for offline sync (last-write-wins)
}): Promise<Record<string, number>> {
  const start = dayjs(data.periodStart);
  const today = dayjs().startOf('day');
  const newRevisions: Record<string, number> = {};

  // Server-side guard: reject writes to a certified (submitted/approved) period
  await assertPeriodEditable(data.userId, data.periodStart);

  // Validate userId and hours for all cells
  validateUUID(data.userId, 'User ID');
  for (const cell of data.cells) {
    validateHours(cell.hours, 'Hours');
    if (cell.clinId) validateUUID(cell.clinId, 'CLIN ID');
    if (cell.indirectCodeId) validateUUID(cell.indirectCodeId, 'Indirect code ID');
  }

  // Server-side guard: reject any entries for future dates
  for (const cell of data.cells) {
    const entryDate = start.add(cell.dayIndex, 'day');
    if (entryDate.isAfter(today, 'day')) {
      throw new Error(`Cannot save hours for future date: ${entryDate.format('MMM D, YYYY')}`);
    }
  }

  // Server-side guard: validate CLIN assignments for direct entries only
  const directCells = data.cells.filter((c) => !c.indirectCodeId);
  const uniqueClinIds = [...new Set(directCells.map((c) => c.clinId).filter(Boolean))];
  for (const clinId of uniqueClinIds) {
    await validateClinAssignment(data.userId, clinId!);
  }

  // Optimistic concurrency control: check expected revisions
  if (!data.skipConflictCheck) {
    for (const cell of data.cells) {
      if (cell.expectedRevision === undefined) continue; // Skip if not provided (backward compatible)

      const entryDate = start.add(cell.dayIndex, 'day').toDate();
      const entryId = cell.clinId ?? cell.indirectCodeId;

      if (!entryId) continue;

      const currentRevision = await db
        .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.userId, data.userId),
            cell.clinId
              ? eq(timesheetEntries.clinId, cell.clinId)
              : eq(timesheetEntries.indirectCodeId, cell.indirectCodeId!),
            eq(timesheetEntries.entryDate, entryDate),
          )
        );

      const dbRevision = currentRevision[0]?.maxRevision ?? 0;

      if (dbRevision !== cell.expectedRevision) {
        const dateLabel = dayjs(entryDate).format('MMM D, YYYY');
        throw new Error(
          `Conflict detected: The entry for ${dateLabel} was modified by another session (expected revision ${cell.expectedRevision}, but server has revision ${dbRevision}). Please refresh your timesheet and re-enter your changes.`
        );
      }
    }
  }

  for (const cell of data.cells) {
    const entryDate = start.add(cell.dayIndex, 'day').toDate();
    const entryId = cell.clinId ?? cell.indirectCodeId ?? '';

    // Get current max revision
    const existing = await db
      .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
      .from(timesheetEntries)
      .where(
        and(
          eq(timesheetEntries.userId, data.userId),
          cell.clinId
            ? eq(timesheetEntries.clinId, cell.clinId)
            : eq(timesheetEntries.indirectCodeId, cell.indirectCodeId!),
          eq(timesheetEntries.entryDate, entryDate),
        )
      );

    const priorRevision = existing[0]?.maxRevision ?? 0;
    const nextRevision = priorRevision + 1;

    // Server-authoritative reason-code determination (ignore client flags).
    // An entry is an EDIT if a prior revision exists.
    // An entry is a LATE entry if it is the first revision for a past-dated cell.
    const serverIsEdit = priorRevision > 0;
    const serverIsLate =
      priorRevision === 0 && dayjs(entryDate).isBefore(today, 'day');
    const requiresReason = serverIsEdit || serverIsLate;

    if (requiresReason) {
      const code = (data.changeReasonCode ?? '').trim();
      if (!code) {
        const label = dayjs(entryDate).format('MMM D, YYYY');
        throw new Error(
          serverIsLate
            ? `A reason code is required for the late entry on ${label}.`
            : `A reason code is required to edit the entry on ${label}.`
        );
      }
      const { REASON_CODES } = await import('@/lib/reason-codes');
      const valid = REASON_CODES.some((rc) => rc.value === code);
      if (!valid) throw new Error(`Invalid change reason code: ${code}`);
    }

    await db.insert(timesheetEntries).values({
      userId: data.userId,
      clinId: cell.clinId ?? null,
      slinId: cell.slinId ?? null,
      indirectCodeId: cell.indirectCodeId ?? null,
      entryDate,
      hours: cell.hours.toString(),
      revisionNumber: nextRevision,
      changeReasonCode: requiresReason ? (data.changeReasonCode ?? undefined) : undefined,
      comment: requiresReason ? (data.comment ?? undefined) : undefined,
      createdBy: data.userId,
    });

    const key = `${entryId}-${cell.dayIndex}`;
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
  slinId?: string;
  entryDate: Date;
  hours: number;
  changeReasonCode?: string;
  comment?: string;
}): Promise<void> {
  // Server-side guard: reject writes to a certified (submitted/approved) period.
  await assertPeriodEditable(data.userId, getPeriodStartForDate(data.entryDate));

  // Validate CLIN assignment (DCAA RBAC enforcement)
  await validateClinAssignment(data.userId, data.clinId);

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

  const priorRevision = existing[0]?.maxRevision ?? 0;
  const nextRevision = priorRevision + 1;

  const isEdit = priorRevision > 0;
  const isLate = priorRevision === 0 && dayjs(data.entryDate).isBefore(dayjs().startOf('day'), 'day');
  if ((isEdit || isLate) && !(data.changeReasonCode ?? '').trim()) {
    throw new Error('A reason code is required for edits and late entries.');
  }

  await db.insert(timesheetEntries).values({
    userId: data.userId,
    clinId: data.clinId,
    slinId: data.slinId ?? null,
    entryDate: data.entryDate,
    hours: data.hours.toString(),
    revisionNumber: nextRevision,
    changeReasonCode: (isEdit || isLate) ? (data.changeReasonCode ?? undefined) : undefined,
    comment: (isEdit || isLate) ? (data.comment ?? undefined) : undefined,
    createdBy: data.userId,
  });
}
