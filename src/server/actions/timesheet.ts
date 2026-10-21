'use server';

import { getDb } from '@/db';
import { timesheetEntries, userAssignments, clins, contracts, slins, indirectChargeCodes, chargeCodes, userChargeCodes, costClasses } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { getNumDaysInPeriod, getPeriodStartForDate } from '@/lib/date-utils';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';
import { validateUUID, validateHours } from '@/lib/validation';
import { requireSession, assertCanAccessEmployee } from '@/lib/session';
import { getPeriodStatusFor } from '@/server/internal/periods';
import { getEffectiveConfigAt } from '@/server/actions/pay-period-config';

/**
 * Validate that a user has an active assignment to a specific charge code.
 * Throws if the user_charge_codes row is missing or inactive.
 * This enforces DCAA RBAC: employees can only charge to authorized codes.
 */
async function validateChargeCodeAssignment(userId: string, chargeCodeId: string): Promise<void> {
  const db = await getDb();
  const assignment = await db
    .select({ id: userChargeCodes.id })
    .from(userChargeCodes)
    .where(
      and(
        eq(userChargeCodes.userId, userId),
        eq(userChargeCodes.chargeCodeId, chargeCodeId),
        eq(userChargeCodes.isActive, true),
      )
    )
    .limit(1);

  if (assignment.length === 0) {
    throw new Error(`Unauthorized: You are not assigned to charge code ${chargeCodeId}. Cannot save timesheet entry.`);
  }
}

/**
 * Validate that a user has an active assignment to a specific CLIN.
 * Used for the legacy CLIN-based cell path (backward compat) and as a fallback check.
 */
async function validateClinAssignment(userId: string, clinId: string): Promise<void> {
  const db = await getDb();
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
  const info = await getPeriodStatusFor(userId, periodStart);
  if (info.status !== 'draft' && info.status !== 'rejected') {
    throw new Error(
      `Cannot modify a ${info.status} timesheet. This period has been certified and is locked. ` +
      `If a correction is required, the supervisor must reject the period first.`
    );
  }
}

/**
 * Get the charge codes assigned to the session user, plus active indirect codes.
 * For DIRECT codes: sources from user_charge_codes → charge_codes → clins → contracts.
 * For INDIRECT codes: unchanged — indirect_charge_codes WHERE available_to_all.
 */
export async function getChargeCodesForUser(): Promise<ChargeCode[]> {
  const actor = await requireSession();
  // R2-12: delegates to the same query the approver-review path uses (getChargeCodesForEmployee)
  // instead of duplicating it — one query to keep correct, not two.
  return getChargeCodesForEmployee(actor.id);
}

/**
 * Get timesheet entries for the session user in a specific pay period.
 * Keys DIRECT entries by chargeCodeId; indirect by indirectCodeId.
 * Returns the LATEST revision for each (chargeCodeId/indirectCodeId, entryDate) pair.
 */
export async function getTimesheetEntries(
  periodStart: Date,
  chargeCodes_param: ChargeCode[]
): Promise<TimesheetEntry[]> {
  const actor = await requireSession();
  // R2-12: delegates to getTimesheetEntriesForEmployee rather than duplicating its query.
  return getTimesheetEntriesForEmployee(actor.id, periodStart, chargeCodes_param);
}

/**
 * Get revision numbers for all cells in a period, for the session user.
 * Keys by chargeCodeId for direct entries, clinId as fallback, indirectCodeId for indirect.
 */
export async function getRevisionMap(
  periodStart: Date,
  numDays: number
): Promise<Record<string, number>> {
  const actor = await requireSession();
  const userId = actor.id;
  const db = await getDb();
  const start = dayjs(periodStart);
  const endDate = start.add(numDays, 'day');

  const rows = await db
    .select({
      chargeCodeId: timesheetEntries.chargeCodeId,
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
    .groupBy(timesheetEntries.chargeCodeId, timesheetEntries.clinId, timesheetEntries.indirectCodeId, timesheetEntries.entryDate);

  const revisionMap: Record<string, number> = {};
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const entryId = row.chargeCodeId ?? row.clinId ?? row.indirectCodeId ?? '';
    const key = `${entryId}-${dayIndex}`;
    revisionMap[key] = row.maxRevision;
  }
  return revisionMap;
}

/**
 * Batch save multiple timesheet entries in a single call, for the session user.
 * Direct entries carry chargeCodeId; the server looks up clinId/slinId and denormalizes them.
 * Preserves all write-path guards: period-lock, late-entry, reason-code enforcement.
 */
export async function saveTimesheetBatch(data: {
  periodStart: Date;
  cells: Array<{
    chargeCodeId?: string;  // set for direct entries (new charge-code model)
    clinId?: string;        // DEPRECATED: set for legacy direct entries (backward compat)
    slinId?: string;
    indirectCodeId?: string;
    dayIndex: number;
    hours: number;
    isEdit: boolean;
    isLateEntry: boolean;
    expectedRevision?: number;
  }>;
  changeReasonCode?: string;
  comment?: string;
  skipConflictCheck?: boolean;
}): Promise<Record<string, number>> {
  const actor = await requireSession();
  const userId = actor.id;
  const db = await getDb();
  const start = dayjs(data.periodStart);
  const today = dayjs().startOf('day');
  const newRevisions: Record<string, number> = {};

  // R2-2: period-lock integrity. `periodStart` must be a REAL period boundary — otherwise
  // getPeriodStatusFor finds no row and treats it as an editable draft — and every cell's
  // dayIndex must land strictly inside THAT period. Without this, a dayIndex outside
  // [0, numDays) computes an entryDate in an ADJACENT period whose own lock status was never
  // checked (assertPeriodEditable below only checks the period named by periodStart).
  const periodConfig = await getEffectiveConfigAt(data.periodStart);
  const canonicalPeriodStart = dayjs(getPeriodStartForDate(data.periodStart, periodConfig)).startOf('day');
  if (!dayjs(data.periodStart).startOf('day').isSame(canonicalPeriodStart, 'day')) {
    throw new Error('Invalid period start date.');
  }
  const numDays = getNumDaysInPeriod(data.periodStart, periodConfig);
  for (const cell of data.cells) {
    if (!Number.isInteger(cell.dayIndex) || cell.dayIndex < 0 || cell.dayIndex >= numDays) {
      throw new Error(`Invalid day index ${cell.dayIndex} for this pay period.`);
    }
  }

  await assertPeriodEditable(userId, data.periodStart);

  validateUUID(userId, 'User ID');
  for (const cell of data.cells) {
    validateHours(cell.hours, 'Hours');
    if (cell.chargeCodeId) validateUUID(cell.chargeCodeId, 'Charge Code ID');
    if (cell.clinId) validateUUID(cell.clinId, 'CLIN ID');
    if (cell.indirectCodeId) validateUUID(cell.indirectCodeId, 'Indirect code ID');
  }

  for (const cell of data.cells) {
    const entryDate = start.add(cell.dayIndex, 'day');
    if (entryDate.isAfter(today, 'day')) {
      throw new Error(`Cannot save hours for future date: ${entryDate.format('MMM D, YYYY')}`);
    }
  }

  // Validate assignments and resolve denormalized clinId/slinId for direct entries
  const chargeCodeCache = new Map<string, { clinId: string; slinId: string | null }>();

  for (const cell of data.cells) {
    if (cell.indirectCodeId) continue; // indirect — no assignment check needed

    if (cell.chargeCodeId) {
      // New charge-code model: validate user_charge_codes assignment
      await validateChargeCodeAssignment(userId, cell.chargeCodeId);
      if (!chargeCodeCache.has(cell.chargeCodeId)) {
        const [cc] = await db.select({ clinId: chargeCodes.clinId, slinId: chargeCodes.slinId })
          .from(chargeCodes)
          .where(eq(chargeCodes.id, cell.chargeCodeId))
          .limit(1);
        if (!cc) throw new Error(`Charge code ${cell.chargeCodeId} not found.`);
        chargeCodeCache.set(cell.chargeCodeId, { clinId: cc.clinId, slinId: cc.slinId ?? null });
      }
    } else if (cell.clinId) {
      // Legacy CLIN-based path (backward compat)
      await validateClinAssignment(userId, cell.clinId);
    }
  }

  // Optimistic concurrency control
  if (!data.skipConflictCheck) {
    for (const cell of data.cells) {
      if (cell.expectedRevision === undefined) continue;
      const entryDate = start.add(cell.dayIndex, 'day').toDate();
      const entryId = cell.chargeCodeId ?? cell.clinId ?? cell.indirectCodeId;
      if (!entryId) continue;

      const whereClause = cell.chargeCodeId
        ? and(eq(timesheetEntries.userId, userId), eq(timesheetEntries.chargeCodeId, cell.chargeCodeId), eq(timesheetEntries.entryDate, entryDate))
        : cell.clinId
          ? and(eq(timesheetEntries.userId, userId), eq(timesheetEntries.clinId, cell.clinId), eq(timesheetEntries.entryDate, entryDate))
          : and(eq(timesheetEntries.userId, userId), eq(timesheetEntries.indirectCodeId, cell.indirectCodeId!), eq(timesheetEntries.entryDate, entryDate));

      const currentRevision = await db
        .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
        .from(timesheetEntries)
        .where(whereClause!);

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
    const entryKey = cell.chargeCodeId ?? cell.clinId ?? cell.indirectCodeId ?? '';

    // Resolve denormalized ids for direct entries
    const resolved = cell.chargeCodeId ? chargeCodeCache.get(cell.chargeCodeId) : null;
    const effectiveClinId = resolved?.clinId ?? cell.clinId ?? null;
    const effectiveSlinId = resolved?.slinId ?? cell.slinId ?? null;

    const whereClause = cell.chargeCodeId
      ? and(eq(timesheetEntries.userId, userId), eq(timesheetEntries.chargeCodeId, cell.chargeCodeId), eq(timesheetEntries.entryDate, entryDate))
      : cell.clinId
        ? and(eq(timesheetEntries.userId, userId), eq(timesheetEntries.clinId, cell.clinId), eq(timesheetEntries.entryDate, entryDate))
        : and(eq(timesheetEntries.userId, userId), eq(timesheetEntries.indirectCodeId, cell.indirectCodeId!), eq(timesheetEntries.entryDate, entryDate));

    const existing = await db
      .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
      .from(timesheetEntries)
      .where(whereClause!);

    const priorRevision = existing[0]?.maxRevision ?? 0;
    const nextRevision = priorRevision + 1;

    const serverIsEdit = priorRevision > 0;
    const serverIsLate = priorRevision === 0 && dayjs(entryDate).isBefore(today, 'day');
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
      userId,
      chargeCodeId: cell.chargeCodeId ?? null,          // new charge code id
      clinId: effectiveClinId,                           // DENORMALIZED from charge code (preserves CLIN-based queries)
      slinId: effectiveSlinId,
      indirectCodeId: cell.indirectCodeId ?? null,
      entryDate,
      hours: cell.hours.toString(),
      revisionNumber: nextRevision,
      changeReasonCode: requiresReason ? (data.changeReasonCode ?? undefined) : undefined,
      comment: requiresReason ? (data.comment ?? undefined) : undefined,
      createdBy: userId,
    });

    const key = `${entryKey}-${cell.dayIndex}`;
    newRevisions[key] = nextRevision;
  }

  return newRevisions;
}

/**
 * Get a read-only view of an employee's timesheet for supervisor/admin review.
 */
export async function getTimesheetForReview(
  employeeId: string,
  periodStart: Date
): Promise<{ chargeCodes: ChargeCode[]; entries: TimesheetEntry[] }> {
  const actor = await requireSession();
  await assertCanAccessEmployee(actor, employeeId);
  const codes = await getChargeCodesForEmployee(employeeId);
  const entries = await getTimesheetEntriesForEmployee(employeeId, periodStart, codes);
  return { chargeCodes: codes, entries };
}

// ---------------------------------------------------------------------------
// Internal helpers shared by the self-only actions above and getTimesheetForReview.
// Not exported from a 'use server' module as "take any userId" — keep these local to this
// file so the public surface above stays self-only; getTimesheetForReview is the only
// other-employee read path, and it authorizes via assertCanAccessEmployee first.
// ---------------------------------------------------------------------------

async function getChargeCodesForEmployee(userId: string): Promise<ChargeCode[]> {
  const db = await getDb();

  const directRows = await db
    .select({
      id: chargeCodes.id,
      code: chargeCodes.code,
      name: chargeCodes.name,
      description: chargeCodes.description,
      clinId: chargeCodes.clinId,
      clinNumber: clins.clinNumber,
      slinId: chargeCodes.slinId,
      slinNumber: slins.slinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      workLocation: chargeCodes.workLocation,
      billable: chargeCodes.billable,
      className: costClasses.name,
    })
    .from(userChargeCodes)
    .innerJoin(chargeCodes, eq(userChargeCodes.chargeCodeId, chargeCodes.id))
    .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
    .leftJoin(costClasses, eq(chargeCodes.classId, costClasses.id))
    .where(
      and(
        eq(userChargeCodes.userId, userId),
        eq(userChargeCodes.isActive, true),
        eq(chargeCodes.isActive, true),
        eq(clins.status, 'active'),
        eq(contracts.status, 'active'),
      )
    )
    .orderBy(contracts.name, clins.clinNumber, chargeCodes.code);

  const directCodes: ChargeCode[] = directRows.map((r) => ({
    id: r.id,
    projectName: r.contractName,
    clin: r.code,
    description: r.name,
    clinId: r.clinId,
    clinNumber: r.clinNumber,
    slinId: r.slinId ?? undefined,
    slinNumber: r.slinNumber ?? undefined,
    workLocation: r.workLocation ?? null,
    billable: r.billable,
    className: r.className ?? undefined,
    isIndirect: false,
  }));

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

  return [...directCodes, ...indirectCodes];
}

async function getTimesheetEntriesForEmployee(
  userId: string,
  periodStart: Date,
  chargeCodes_param: ChargeCode[]
): Promise<TimesheetEntry[]> {
  const db = await getDb();
  const numDays = getNumDaysInPeriod(periodStart);
  const start = dayjs(periodStart);
  const endDate = start.add(numDays, 'day');

  const rows = await db
    .select({
      chargeCodeId: timesheetEntries.chargeCodeId,
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
    .orderBy(timesheetEntries.chargeCodeId, timesheetEntries.entryDate, desc(timesheetEntries.revisionNumber));

  const latestHours = new Map<string, number>();
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const entryId = row.chargeCodeId ?? row.clinId ?? row.indirectCodeId ?? '';
    const key = `${entryId}-${dayIndex}`;
    if (!latestHours.has(key)) {
      latestHours.set(key, parseFloat(row.hours));
    }
  }

  return chargeCodes_param.map((cc) => {
    const hours: number[] = [];
    for (let i = 0; i < numDays; i++) {
      const key = `${cc.id}-${i}`;
      hours.push(latestHours.get(key) ?? 0);
    }
    return { chargeCodeId: cc.id, hours };
  });
}
