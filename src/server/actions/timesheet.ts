'use server';

import { getDb, getDbForWrite } from '@/db';
import { timesheetEntries, clins, contracts, slins, indirectChargeCodes, chargeCodes, userChargeCodes, costClasses, timesheetPeriods, importBatches, users } from '@/db/schema';
import { provenanceText } from '@/lib/provenance';
import { INDIRECT_CATEGORY_LABELS } from '@/lib/indirect-categories';
import { eq, and, gte, lt, desc, sql, isNull, inArray } from 'drizzle-orm';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';
import { validateUUID, validateHours } from '@/lib/validation';
import { requireSession, assertCanAccessEmployee, AuthorizationError } from '@/lib/session';
import { isUniqueViolation } from '@/lib/db-errors';
import { assertEntryDatesEditable, lockEmployeeTimesheet, resolvePeriod } from '@/server/internal/periods';
import { configAt, existingPeriodLength } from '@/server/internal/pay-period-config';
import { getPeriodStatusFor, type PeriodStatus } from '@/server/internal/periods';
import type { PeriodConfig } from '@/lib/date-utils';
import { getWorkspaceTimezone, getWorkspaceToday } from '@/server/internal/workspace-settings';
import { canApprove, loadApprovalFacts } from '@/server/internal/approval-rules';
import { approvalLabels } from '@/server/internal/approval-label';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import { addDays, diffDays, isAfter, isBefore, formatCalendarDate, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { ConflictError, UserFacingError } from '@/lib/errors';
import { newCellRefusal } from '@/lib/timesheet/cell-rules';
import { userAction, type ActionResult } from '@/lib/action-result';

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
  /** certified-outputs C2: "Self-approved"/"Self-rejected" for this period (approvalLabel), else null. */
  approvalBadge: string | null;
  /** certified-outputs C4: THIS period's code list (assignable ∪ recorded); the client replaces its list with it. */
  chargeCodes: ChargeCode[];
}> {
  const actor = await requireSession();
  const start = parseCalendarDate(periodStart);
  const db = await getDb();
  const [numDays, periodConfig, periodInfo] = await Promise.all([
    periodLengthFor(actor.id, start),
    configAt(db, start),
    getPeriodStatusFor(actor.id, start),
  ]);
  const periodCodes = await getPeriodCodesForEmployee(actor.id, start, numDays);
  const [entries, revisions] = await Promise.all([
    getTimesheetEntriesForEmployee(actor.id, start, periodCodes),
    revisionMapFor(actor.id, start, numDays),
  ]);
  const approvalBadge = periodInfo.id
    ? (await approvalLabels(db, [{ id: periodInfo.id, userId: actor.id, status: periodInfo.status, reviewedBy: periodInfo.reviewedBy, reviewedAt: periodInfo.reviewedAt }], await getWorkspaceTimezone())).get(periodInfo.id)?.badge ?? null
    : null;
  return { periodStart: start, numDays, periodConfig, entries, revisions, periodStatus: periodInfo.status, approvalBadge, chargeCodes: periodCodes };
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

    // CLIN/SLIN of each charge code, filled inside the transaction (FOR SHARE re-read, C3).
    const chargeCodeCache = new Map<string, { clinId: string; slinId: string | null }>();
    for (const cell of data.cells) if (cell.chargeCodeId) chargeCodeCache.set(cell.chargeCodeId, { clinId: '', slinId: null });

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

        // certified-outputs C3: re-read each charge code's CLIN/SLIN INSIDE the transaction, FOR SHARE, and use those
        // values for the insert — a concurrent updateChargeCode (FOR UPDATE) either finishes first (we see the new CLIN
        // and its "used code" check sees no entries yet) or waits for us (and then sees this save's entries).
        const chargeCodeIds = [...chargeCodeCache.keys()];
        if (chargeCodeIds.length) {
          const fresh = await tx.select({ id: chargeCodes.id, clinId: chargeCodes.clinId, slinId: chargeCodes.slinId })
            .from(chargeCodes).where(inArray(chargeCodes.id, chargeCodeIds)).for('share');
          for (const cc of fresh) chargeCodeCache.set(cc.id, { clinId: cc.clinId, slinId: cc.slinId ?? null });
          if (fresh.length !== chargeCodeIds.length) throw new UserFacingError('A charge code on this timesheet no longer exists. Refresh and try again.', 'not_found');
        }

        // certified-outputs C4 (CO-D8/CO-D15, rulings Q1/Q4): the facts for NEW cells, read through this transaction.
        // A cell with a prior revision is a correction and skips them (reason code + period lock still apply).
        const assignedCodes = chargeCodeIds.length === 0 ? new Set<string>() : new Set((await tx
          .select({ id: userChargeCodes.chargeCodeId }).from(userChargeCodes)
          .where(and(eq(userChargeCodes.userId, userId), inArray(userChargeCodes.chargeCodeId, chargeCodeIds), eq(userChargeCodes.isActive, true))))
          .map((r) => r.id));
        const codeState = new Map((chargeCodeIds.length === 0 ? [] : await tx
          .select({ id: chargeCodes.id, codeActive: chargeCodes.isActive, clinStatus: clins.status, contractStatus: contracts.status })
          .from(chargeCodes).innerJoin(clins, eq(chargeCodes.clinId, clins.id)).innerJoin(contracts, eq(clins.contractId, contracts.id))
          .where(inArray(chargeCodes.id, chargeCodeIds))).map((r) => [r.id, r]));
        const indirectIds = [...new Set(data.cells.flatMap((c) => (c.indirectCodeId ? [c.indirectCodeId] : [])))];
        const indirectState = new Map((indirectIds.length === 0 ? [] : await tx
          .select({ id: indirectChargeCodes.id, isActive: indirectChargeCodes.isActive, availableToAll: indirectChargeCodes.availableToAll })
          .from(indirectChargeCodes).where(inArray(indirectChargeCodes.id, indirectIds))).map((r) => [r.id, r]));

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

          const whereClause = cellWhere(userId, cell, entryDate);

          const existing = await tx
            .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
            .from(timesheetEntries)
            .where(whereClause!);

          const priorRevision = existing[0]?.maxRevision ?? 0;
          const nextRevision = priorRevision + 1;

          // C4: a NEW cell needs the full assignable rule; a cell with a prior revision is correctable on any code.
          if (priorRevision === 0) {
            const refusal = cell.chargeCodeId
              ? newCellRefusal({
                kind: 'charge',
                assigned: assignedCodes.has(cell.chargeCodeId),
                codeActive: codeState.get(cell.chargeCodeId)?.codeActive ?? false,
                clinActive: codeState.get(cell.chargeCodeId)?.clinStatus === 'active',
                contractActive: codeState.get(cell.chargeCodeId)?.contractStatus === 'active',
              })
              : cell.indirectCodeId
                ? newCellRefusal({ kind: 'indirect', active: indirectState.get(cell.indirectCodeId)?.isActive ?? false, availableToAll: indirectState.get(cell.indirectCodeId)?.availableToAll ?? false })
                : newCellRefusal({ kind: 'clin' });
            const label = formatCalendarDate(entryDate, 'MMM D, YYYY');
            if (refusal === 'not-assigned') {
              throw new AuthorizationError('forbidden', `Unauthorized: You are not assigned to charge code ${cell.chargeCodeId}. Cannot save timesheet entry.`);
            }
            if (refusal === 'code-inactive') {
              throw new UserFacingError(`This charge code is no longer active (or its CLIN or contract isn't), so new hours can't be added on ${label}. You can correct hours already recorded on it.`);
            }
            if (refusal === 'indirect-unavailable') throw new UserFacingError(`Indirect code ${cell.indirectCodeId} is not available.`);
            if (refusal === 'clin-only') {
              throw new UserFacingError(`New hours can't be added to a CLIN-only row (${label}). Use a charge code — hours already recorded on the CLIN can still be corrected.`);
            }
          }

          // Charge-code cells take CLIN/SLIN only from the charge code itself (in-transaction re-read), never the caller.
          // A legacy CLIN cell (always a correction here) keeps its prior revision's SLIN; a different client SLIN is refused.
          let effectiveClinId: string | null = cell.clinId ?? null;
          let effectiveSlinId: string | null = null;
          if (cell.chargeCodeId) {
            const resolved = chargeCodeCache.get(cell.chargeCodeId)!;
            effectiveClinId = resolved.clinId;
            effectiveSlinId = resolved.slinId;
          } else if (cell.clinId) {
            const [prior] = await tx.select({ slinId: timesheetEntries.slinId }).from(timesheetEntries)
              .where(and(whereClause!, eq(timesheetEntries.revisionNumber, priorRevision))).limit(1);
            const priorSlin = prior?.slinId ?? null;
            if (cell.slinId && cell.slinId !== priorSlin) {
              throw new UserFacingError('A correction on a CLIN-only row keeps the SLIN it was recorded on.');
            }
            effectiveSlinId = priorSlin;
          }

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
 * Get a read-only view of an employee's timesheet for supervisor/admin review. Scope: the review scope
 * (feature-plan-certified-outputs.md C2 — designees see the people who designated them).
 *
 * C2 "approve exactly what was reviewed": `submissionCount` is read BEFORE the entries. Entries only change while the
 * period is draft/rejected, so if anything changed after this read the period was resubmitted, the count moved past the
 * value returned here, and approve/reject with `seen = submissionCount` is refused ("resubmitted").
 */
export async function getTimesheetForReview(
  employeeId: string,
  periodStart: CalendarDate
): Promise<{
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  periodStatus: PeriodStatus;
  submissionCount: number;
  canApprove: boolean;
  approvalBadge: string | null;
  approvalText: string | null;
}> {
  const actor = await requireSession();
  await assertCanAccessEmployee(actor, employeeId);
  const start = parseCalendarDate(periodStart);
  const db = await getDb();
  const [period] = await db.select({
    id: timesheetPeriods.id, status: timesheetPeriods.status, submissionCount: timesheetPeriods.submissionCount,
    reviewedBy: timesheetPeriods.reviewedBy, reviewedAt: timesheetPeriods.reviewedAt,
  }).from(timesheetPeriods).where(and(eq(timesheetPeriods.userId, employeeId), eq(timesheetPeriods.periodStart, start)));
  // C4: the review shows every recorded hour (the same period code list as the employee's grid).
  const codes = await getPeriodCodesForEmployee(employeeId, start, await periodLengthFor(employeeId, start));
  const entries = await getTimesheetEntriesForEmployee(employeeId, start, codes);
  const facts = await loadApprovalFacts(db);
  const label = period
    ? (await approvalLabels(db, [{ id: period.id, userId: employeeId, status: period.status, reviewedBy: period.reviewedBy, reviewedAt: period.reviewedAt }], await getWorkspaceTimezone())).get(period.id)
    : undefined;
  return {
    chargeCodes: codes,
    entries,
    periodStatus: period?.status ?? 'draft',
    submissionCount: period?.submissionCount ?? 0,
    canApprove: period?.status === 'submitted' && canApprove(facts, actor.id, employeeId),
    approvalBadge: label?.badge ?? null,
    approvalText: label?.text ?? null,
  };
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
    kind: 'charge' as const,
    assignable: true,
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

  const indirectCodes: ChargeCode[] = indirectRows.map((r) => ({
    id: r.id,
    projectName: INDIRECT_CATEGORY_LABELS[r.category] ?? r.category,
    clin: r.code,
    description: r.description ?? r.name,
    isIndirect: true,
    indirectCategory: r.category,
    kind: 'indirect' as const,
    assignable: true,
  }));

  return [...directCodes, ...indirectCodes];
}

/**
 * feature-plan-certified-outputs.md C4: the period's code list = the assignable codes ∪ every code (charge code, legacy
 * CLIN, indirect) with an entry in the period (0-hour rows included). Codes with recorded hours that are no longer
 * assignable come back with `assignable: false` (correction-only, CO-D8); legacy CLIN rows always do (ruling Q1).
 */
async function getPeriodCodesForEmployee(userId: string, start: CalendarDate, numDays: number): Promise<ChargeCode[]> {
  const db = await getDb();
  const assignable = await getChargeCodesForEmployee(userId);
  const known = new Set(assignable.map((c) => `${c.kind}:${c.id}`));
  const recorded = await db
    .selectDistinct({ chargeCodeId: timesheetEntries.chargeCodeId, clinId: timesheetEntries.clinId, indirectCodeId: timesheetEntries.indirectCodeId })
    .from(timesheetEntries)
    .where(and(eq(timesheetEntries.userId, userId), gte(timesheetEntries.entryDate, start), lt(timesheetEntries.entryDate, addDays(start, numDays))));
  const chargeIds = [...new Set(recorded.flatMap((r) => (r.chargeCodeId && !known.has(`charge:${r.chargeCodeId}`) ? [r.chargeCodeId] : [])))];
  const clinIds = [...new Set(recorded.flatMap((r) => (!r.chargeCodeId && !r.indirectCodeId && r.clinId ? [r.clinId] : [])))];
  const indirectIds = [...new Set(recorded.flatMap((r) => (r.indirectCodeId && !known.has(`indirect:${r.indirectCodeId}`) ? [r.indirectCodeId] : [])))];

  const extraCharge: ChargeCode[] = chargeIds.length === 0 ? [] : (await db
    .select({
      id: chargeCodes.id, code: chargeCodes.code, name: chargeCodes.name, clinId: chargeCodes.clinId, clinNumber: clins.clinNumber,
      slinId: chargeCodes.slinId, slinNumber: slins.slinNumber, contractName: contracts.name, workLocation: chargeCodes.workLocation,
      billable: chargeCodes.billable, className: costClasses.name,
    })
    .from(chargeCodes)
    .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
    .leftJoin(costClasses, eq(chargeCodes.classId, costClasses.id))
    .where(inArray(chargeCodes.id, chargeIds))
    .orderBy(contracts.name, clins.clinNumber, chargeCodes.code))
    .map((r) => ({
      id: r.id, projectName: r.contractName, clin: r.code, description: r.name, clinId: r.clinId, clinNumber: r.clinNumber,
      slinId: r.slinId ?? undefined, slinNumber: r.slinNumber ?? undefined, workLocation: r.workLocation ?? null, billable: r.billable,
      className: r.className ?? undefined, isIndirect: false, kind: 'charge' as const, assignable: false,
    }));
  const extraClin: ChargeCode[] = clinIds.length === 0 ? [] : (await db
    .select({ id: clins.id, clinNumber: clins.clinNumber, description: clins.description, contractName: contracts.name })
    .from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(inArray(clins.id, clinIds))
    .orderBy(contracts.name, clins.clinNumber))
    .map((r) => ({
      id: r.id, projectName: r.contractName, clin: `CLIN ${r.clinNumber}`, description: r.description ?? `CLIN ${r.clinNumber}`,
      clinId: r.id, clinNumber: r.clinNumber, isIndirect: false, kind: 'clin' as const, assignable: false,
    }));
  const extraIndirect: ChargeCode[] = indirectIds.length === 0 ? [] : (await db
    .select().from(indirectChargeCodes).where(inArray(indirectChargeCodes.id, indirectIds)).orderBy(indirectChargeCodes.category, indirectChargeCodes.code))
    .map((r) => ({
      id: r.id, projectName: INDIRECT_CATEGORY_LABELS[r.category] ?? r.category, clin: r.code, description: r.description ?? r.name,
      isIndirect: true, indirectCategory: r.category, kind: 'indirect' as const, assignable: false,
    }));

  const direct = [...assignable.filter((c) => c.kind === 'charge'), ...extraCharge, ...extraClin];
  const indirect = [...assignable.filter((c) => c.kind === 'indirect'), ...extraIndirect];
  return [...direct, ...indirect];
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
      // C1 display: provenance of the latest revision (imported rows are labelled in the grid and the review).
      source: timesheetEntries.source,
      changeReasonCode: timesheetEntries.changeReasonCode,
      originalMetadata: timesheetEntries.originalMetadata,
      importSourceSystem: importBatches.sourceSystem,
      importedAt: importBatches.importedAt,
      importedByName: users.fullName,
    })
    .from(timesheetEntries)
    .leftJoin(importBatches, eq(timesheetEntries.importBatchId, importBatches.id))
    .leftJoin(users, eq(importBatches.importedBy, users.id))
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, periodStart),
        lt(timesheetEntries.entryDate, endDateExclusive),
      )
    )
    .orderBy(timesheetEntries.chargeCodeId, timesheetEntries.entryDate, desc(timesheetEntries.revisionNumber));

  // The cell identity matches COALESCE(charge_code_id, indirect_code_id, clin_id): a legacy CLIN-only row is keyed by
  // its CLIN, which never collides with a charge-code or indirect id.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const dayIndex = diffDays(periodStart, row.entryDate as CalendarDate);
    const entryId = row.chargeCodeId ?? row.indirectCodeId ?? row.clinId ?? '';
    const key = `${entryId}-${dayIndex}`;
    if (!latest.has(key)) latest.set(key, row);
  }

  return chargeCodes_param.map((cc) => {
    const hours: number[] = [];
    const provenance: Array<string | null> = [];
    for (let i = 0; i < numDays; i++) {
      const row = latest.get(`${cc.id}-${i}`);
      hours.push(row ? parseFloat(row.hours) : 0);
      provenance.push(row ? provenanceText(row) : null);
    }
    return provenance.some(Boolean) ? { chargeCodeId: cc.id, hours, provenance } : { chargeCodeId: cc.id, hours };
  });
}
