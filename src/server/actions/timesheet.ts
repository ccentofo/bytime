'use server';

import { getDb, getDbForWrite } from '@/db';
import { timesheetEntries, userAssignments, clins, contracts, slins, indirectChargeCodes, chargeCodes, userChargeCodes, costClasses, timesheetPeriods } from '@/db/schema';
import { eq, and, gte, lt, desc, sql, isNull } from 'drizzle-orm';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';
import { validateUUID, validateHours } from '@/lib/validation';
import { requireSession, assertCanAccessEmployee, AuthorizationError } from '@/lib/session';
import { isUniqueViolation } from '@/lib/db-errors';
import { assertEntryDatesEditable, lockEmployeeTimesheet, resolvePeriod } from '@/server/internal/periods';
import { configAt, existingPeriodLength } from '@/server/internal/pay-period-config';
import { getPeriodStatusFor, type PeriodStatus } from '@/server/internal/periods';
import type { PeriodConfig } from '@/lib/date-utils';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import { addDays, diffDays, isAfter, isBefore, formatCalendarDate, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { ConflictError, UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

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
    throw new AuthorizationError('forbidden', `Unauthorized: You are not assigned to charge code ${chargeCodeId}. Cannot save timesheet entry.`);
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
    throw new AuthorizationError('forbidden', `Unauthorized: You are not assigned to CLIN ${clinId}. Cannot save timesheet entry.`);
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
  periodStart: CalendarDate,
  chargeCodes_param: ChargeCode[]
): Promise<TimesheetEntry[]> {
  const actor = await requireSession();
  // R2-12: delegates to getTimesheetEntriesForEmployee rather than duplicating its query.
  return getTimesheetEntriesForEmployee(actor.id, parseCalendarDate(periodStart), chargeCodes_param);
}

/**
 * Get revision numbers for all cells in a period, for the session user.
 * Keys by chargeCodeId for direct entries, clinId as fallback, indirectCodeId for indirect.
 * The period's length is resolved on the server (snapshot or schedule), never taken from the client.
 */
export async function getRevisionMap(periodStart: CalendarDate): Promise<Record<string, number>> {
  const actor = await requireSession();
  const start = parseCalendarDate(periodStart);
  return revisionMapFor(actor.id, start, await periodLengthFor(actor.id, start));
}

/**
 * Everything the timesheet screen needs for one period, resolved on the server in one call:
 * its length and schedule, the session user's entries and revision numbers, and its status.
 * The client does no schedule math; it renders exactly this.
 */
export async function getTimesheetPeriod(periodStart: CalendarDate): Promise<{
  periodStart: CalendarDate;
  numDays: number;
  periodConfig: PeriodConfig;
  entries: TimesheetEntry[];
  revisions: Record<string, number>;
  periodStatus: PeriodStatus;
}> {
  const actor = await requireSession();
  const start = parseCalendarDate(periodStart);
  const db = await getDb();
  const [numDays, periodConfig, chargeCodes, periodInfo] = await Promise.all([
    periodLengthFor(actor.id, start),
    configAt(db, start),
    getChargeCodesForEmployee(actor.id),
    getPeriodStatusFor(actor.id, start),
  ]);
  const [entries, revisions] = await Promise.all([
    getTimesheetEntriesForEmployee(actor.id, start, chargeCodes),
    revisionMapFor(actor.id, start, numDays),
  ]);
  return { periodStart: start, numDays, periodConfig, entries, revisions, periodStatus: periodInfo.status };
}

/** This employee's length for the period at `start`: their stored snapshot, else the schedule. */
async function periodLengthFor(userId: string, start: CalendarDate): Promise<number> {
  const db = await getDb();
  const [periodRow] = await db
    .select({ periodNumDays: timesheetPeriods.periodNumDays })
    .from(timesheetPeriods)
    .where(and(eq(timesheetPeriods.userId, userId), eq(timesheetPeriods.periodStart, start)))
    .limit(1);
  return existingPeriodLength(db, start, periodRow?.periodNumDays);
}

async function revisionMapFor(userId: string, start: CalendarDate, numDays: number): Promise<Record<string, number>> {
  const db = await getDb();
  const endDateExclusive = addDays(start, numDays);

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
        gte(timesheetEntries.entryDate, start),
        lt(timesheetEntries.entryDate, endDateExclusive),
      )
    )
    .groupBy(timesheetEntries.chargeCodeId, timesheetEntries.clinId, timesheetEntries.indirectCodeId, timesheetEntries.entryDate);

  const revisionMap: Record<string, number> = {};
  for (const row of rows) {
    const dayIndex = diffDays(start, row.entryDate as CalendarDate);
    const entryId = row.chargeCodeId ?? row.clinId ?? row.indirectCodeId ?? '';
    const key = `${entryId}-${dayIndex}`;
    revisionMap[key] = row.maxRevision;
  }
  return revisionMap;
}

type CellRef = { chargeCodeId?: string; clinId?: string; indirectCodeId?: string };

/**
 * The rows of one timesheet cell, matching the database's cell identity
 * `COALESCE(charge_code_id, indirect_code_id, clin_id)` (the per-cell revision unique index). A legacy
 * CLIN-only cell must not count charge-code rows that merely carry the same denormalized CLIN.
 */
function cellWhere(userId: string, cell: CellRef, entryDate: CalendarDate) {
  const base = [eq(timesheetEntries.userId, userId), eq(timesheetEntries.entryDate, entryDate)];
  if (cell.chargeCodeId) return and(...base, eq(timesheetEntries.chargeCodeId, cell.chargeCodeId));
  if (cell.indirectCodeId) return and(...base, eq(timesheetEntries.indirectCodeId, cell.indirectCodeId), isNull(timesheetEntries.chargeCodeId));
  return and(...base, eq(timesheetEntries.clinId, cell.clinId!), isNull(timesheetEntries.chargeCodeId), isNull(timesheetEntries.indirectCodeId));
}

/**
 * Batch save multiple timesheet entries in a single call, for the session user.
 * Direct entries carry chargeCodeId; the server looks up clinId/slinId and denormalizes them.
 * Preserves all write-path guards: period-lock, late-entry, reason-code enforcement.
 */
export async function saveTimesheetBatch(data: {
  periodStart: CalendarDate;
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
}): Promise<ActionResult<Record<string, number>>> {
  return userAction(async () => {
    const actor = await requireSession();
    const userId = actor.id;
    const db = await getDbForWrite();
    const start = parseCalendarDate(data.periodStart);
    const today = await getWorkspaceToday();
    const newRevisions: Record<string, number> = {};

    // R2-2 / D3: period-lock integrity. `periodStart` must be a real period boundary and every
    // dayIndex must land inside that period; then every entry DATE is checked against the user's
    // locked periods (assertEntryDatesEditable), so neither an out-of-range dayIndex nor a
    // periodStart from a stale period can reach a certified period.
    const { numDays } = await resolvePeriod(start);
    for (const cell of data.cells) {
      if (!Number.isInteger(cell.dayIndex) || cell.dayIndex < 0 || cell.dayIndex >= numDays) {
        throw new UserFacingError(`Invalid day index ${cell.dayIndex} for this pay period.`);
      }
    }

    validateUUID(userId, 'User ID');
    for (const cell of data.cells) {
      // A cell is exactly ONE kind of code. A cell naming several would skip the charge-code
      // assignment check (the indirect branch below returns early) while still storing the
      // caller's charge code / CLIN, i.e. booking hours to a contract the user isn't assigned to.
      const kinds = [cell.chargeCodeId, cell.clinId, cell.indirectCodeId].filter(Boolean).length;
      if (kinds !== 1) {
        throw new UserFacingError('Each timesheet cell must reference exactly one charge code, CLIN, or indirect code.');
      }
      if (cell.slinId && !cell.clinId) {
        throw new UserFacingError('A SLIN can only be given with a legacy CLIN entry.');
      }
      validateHours(cell.hours, 'Hours');
      if (cell.chargeCodeId) validateUUID(cell.chargeCodeId, 'Charge Code ID');
      if (cell.clinId) validateUUID(cell.clinId, 'CLIN ID');
      if (cell.indirectCodeId) validateUUID(cell.indirectCodeId, 'Indirect code ID');
    }

    for (const cell of data.cells) {
      const entryDate = addDays(start, cell.dayIndex);
      if (isAfter(entryDate, today)) {
        throw new UserFacingError(`Cannot save hours for future date: ${formatCalendarDate(entryDate, 'MMM D, YYYY')}`);
      }
    }

    // Validate assignments and resolve denormalized clinId/slinId for direct entries
    const chargeCodeCache = new Map<string, { clinId: string; slinId: string | null }>();

    const checkedIndirectCodes = new Set<string>();
    for (const cell of data.cells) {
      if (cell.indirectCodeId) {
        // Indirect codes need no assignment, but must exist and be open to everyone — the same
        // filter getChargeCodesForUser uses to offer them.
        if (!checkedIndirectCodes.has(cell.indirectCodeId)) {
          const [code] = await db.select({ id: indirectChargeCodes.id })
            .from(indirectChargeCodes)
            .where(and(
              eq(indirectChargeCodes.id, cell.indirectCodeId),
              eq(indirectChargeCodes.isActive, true),
              eq(indirectChargeCodes.availableToAll, true),
            ))
            .limit(1);
          if (!code) throw new UserFacingError(`Indirect code ${cell.indirectCodeId} is not available.`);
          checkedIndirectCodes.add(cell.indirectCodeId);
        }
        continue;
      }

      if (cell.chargeCodeId) {
        // New charge-code model: validate user_charge_codes assignment
        await validateChargeCodeAssignment(userId, cell.chargeCodeId);
        if (!chargeCodeCache.has(cell.chargeCodeId)) {
          const [cc] = await db.select({ clinId: chargeCodes.clinId, slinId: chargeCodes.slinId })
            .from(chargeCodes)
            .where(eq(chargeCodes.id, cell.chargeCodeId))
            .limit(1);
          if (!cc) throw new UserFacingError(`Charge code ${cell.chargeCodeId} not found.`, 'not_found');
          chargeCodeCache.set(cell.chargeCodeId, { clinId: cc.clinId, slinId: cc.slinId ?? null });
        }
      } else if (cell.clinId) {
        // Legacy CLIN-based path (backward compat)
        await validateClinAssignment(userId, cell.clinId);
        if (cell.slinId) {
          const [slin] = await db.select({ id: slins.id }).from(slins)
            .where(and(eq(slins.id, cell.slinId), eq(slins.clinId, cell.clinId))).limit(1);
          if (!slin) throw new UserFacingError(`SLIN ${cell.slinId} does not belong to CLIN ${cell.clinId}.`);
        }
      }
    }

    // One transaction holding this employee's timesheet lock (shared with submitPeriod): the period-lock check,
    // the conflict check and every insert see the same state, so a save can't land in a period that's being
    // submitted, and a save is all-or-nothing (a failing cell leaves nothing half-written).
    try {
      await db.transaction(async (tx) => {
        await lockEmployeeTimesheet(tx, userId);
        await assertEntryDatesEditable(
          userId,
          data.cells.map((cell) => addDays(start, cell.dayIndex)),
          // Read the schedule through the same transaction: never a second connection while holding the lock.
          async (periodStart) => getNumDaysInPeriod(periodStart, await configAt(tx, periodStart)),
          tx,
        );

        // Optimistic concurrency control
        if (!data.skipConflictCheck) {
          for (const cell of data.cells) {
            if (cell.expectedRevision === undefined) continue;
            const entryDate = addDays(start, cell.dayIndex);
            const entryId = cell.chargeCodeId ?? cell.clinId ?? cell.indirectCodeId;
            if (!entryId) continue;

            const whereClause = cellWhere(userId, cell, entryDate);

            const currentRevision = await tx
              .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
              .from(timesheetEntries)
              .where(whereClause!);

            const dbRevision = currentRevision[0]?.maxRevision ?? 0;
            if (dbRevision !== cell.expectedRevision) {
              throw new ConflictError(
                `Conflict detected: The entry for ${formatCalendarDate(entryDate, 'MMM D, YYYY')} was modified by another session (expected revision ${cell.expectedRevision}, but server has revision ${dbRevision}). Please refresh your timesheet and re-enter your changes.`
              );
            }
          }
        }

        for (const cell of data.cells) {
          const entryDate = addDays(start, cell.dayIndex);
          const entryKey = cell.chargeCodeId ?? cell.clinId ?? cell.indirectCodeId ?? '';

          // Resolve denormalized ids for direct entries
          const resolved = cell.chargeCodeId ? chargeCodeCache.get(cell.chargeCodeId) : null;
          // Charge-code cells take CLIN/SLIN only from the charge code itself, never from the caller.
          const effectiveClinId = cell.chargeCodeId ? resolved!.clinId : (cell.clinId ?? null);
          const effectiveSlinId = cell.chargeCodeId ? resolved!.slinId : (cell.slinId ?? null);

          const whereClause = cellWhere(userId, cell, entryDate);

          const existing = await tx
            .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
            .from(timesheetEntries)
            .where(whereClause!);

          const priorRevision = existing[0]?.maxRevision ?? 0;
          const nextRevision = priorRevision + 1;

          const serverIsEdit = priorRevision > 0;
          const serverIsLate = priorRevision === 0 && isBefore(entryDate, today);
          const requiresReason = serverIsEdit || serverIsLate;

          if (requiresReason) {
            const code = (data.changeReasonCode ?? '').trim();
            if (!code) {
              const label = formatCalendarDate(entryDate, 'MMM D, YYYY');
              throw new UserFacingError(
                serverIsLate
                  ? `A reason code is required for the late entry on ${label}.`
                  : `A reason code is required to edit the entry on ${label}.`
              );
            }
            const { REASON_CODES } = await import('@/lib/reason-codes');
            const valid = REASON_CODES.some((rc) => rc.value === code);
            if (!valid) throw new UserFacingError(`Invalid change reason code: ${code}`);
          }

          // The new unique index (user, code, day, revision) can reject a genuine race — two
          // concurrent saves both reading the same priorRevision and trying to insert the same
          // nextRevision. Surface that as the existing conflict message rather than a raw DB error.
          try {
            await tx.insert(timesheetEntries).values({
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
          } catch (err) {
            // Another save inserted this cell's next revision between our read and our insert.
            if (isUniqueViolation(err, 'entries_user_code_date_rev_unique_idx')) {
              throw new ConflictError(
                `Conflict detected: The entry for ${formatCalendarDate(entryDate, 'MMM D, YYYY')} was modified by another session. Please refresh your timesheet and re-enter your changes.`
              );
            }
            throw err;
          }

          const key = `${entryKey}-${cell.dayIndex}`;
          newRevisions[key] = nextRevision;
        }
      });
    } catch (err) {
      // Another save inserted a cell's next revision first (the per-cell unique index); caught outside the
      // transaction because Postgres aborts the transaction on the violation.
      if (isUniqueViolation(err, 'entries_user_code_date_rev_unique_idx')) {
        throw new ConflictError('Conflict detected: one of these entries was modified by another session. Please refresh your timesheet and re-enter your changes.');
      }
      throw err;
    }

    return newRevisions;
  });
}

/**
 * Get a read-only view of an employee's timesheet for supervisor/admin review.
 */
export async function getTimesheetForReview(
  employeeId: string,
  periodStart: CalendarDate
): Promise<{ chargeCodes: ChargeCode[]; entries: TimesheetEntry[] }> {
  const actor = await requireSession();
  await assertCanAccessEmployee(actor, employeeId);
  const codes = await getChargeCodesForEmployee(employeeId);
  const entries = await getTimesheetEntriesForEmployee(employeeId, parseCalendarDate(periodStart), codes);
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
  periodStart: CalendarDate,
  chargeCodes_param: ChargeCode[]
): Promise<TimesheetEntry[]> {
  const db = await getDb();
  // D3/§0.6: the period's REAL length (this employee's snapshot, else the schedule). Non-throwing:
  // reading must work for any stored period, including imported history.
  const numDays = await periodLengthFor(userId, periodStart);
  const endDateExclusive = addDays(periodStart, numDays);

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
        gte(timesheetEntries.entryDate, periodStart),
        lt(timesheetEntries.entryDate, endDateExclusive),
      )
    )
    .orderBy(timesheetEntries.chargeCodeId, timesheetEntries.entryDate, desc(timesheetEntries.revisionNumber));

  const latestHours = new Map<string, number>();
  for (const row of rows) {
    const dayIndex = diffDays(periodStart, row.entryDate as CalendarDate);
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
