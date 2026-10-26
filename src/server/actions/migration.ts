'use server';

import { and, between, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { getDb, getDbForWrite, type DbTx } from '@/db';
import { importBatches, periodEvents, timesheetEntries, timesheetPeriods } from '@/db/schema';
import { requireAdminFresh } from '@/lib/session';
import { isUniqueViolation } from '@/lib/db-errors';
import { ConflictError } from '@/lib/errors';
import { addDays, isAfter, isBefore, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import { validateRequired, validateStringLength } from '@/lib/validation';
import { getTenantOrThrow } from '@/lib/tenant/context';
import { lockEmployeeTimesheet, resolvePeriod } from '@/server/internal/periods';
import { configAt } from '@/server/internal/pay-period-config';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { assertImportWindowOpen, lockImportWindowExclusive } from '@/server/internal/import-window';
import { validateMigrationDataInternal, validateMigrationPeriodsInternal } from '@/server/internal/migration';
import {
  MIGRATION_INSERT_CHUNK,
  assertMigrationBatchWithinLimits,
  parseImportHours,
  planEntryImport,
  planPeriodImport,
  type EntryCandidate,
  type PeriodCandidate,
} from '@/lib/migration/import-plan';
import type {
  MigrationEntryRow,
  MigrationPeriodRow,
  MigrationPeriodValidationResult,
  MigrationResult,
  MigrationValidationResult,
} from '@/types/migration';
import { userAction, type ActionResult } from '@/lib/action-result';

/**
 * Timesheet-history migration (feature-plan-certified-outputs.md C1, CO-D1). History is importable only while the
 * import window is open (src/server/internal/import-window.ts). Each batch is ONE transaction: exclusive window lock →
 * window re-checked → per-employee timesheet locks (sorted ids) → bulk pre-checks (src/lib/migration/import-plan.ts) →
 * the import_batches row (final counts) → the rows that reference it. Imported rows are attributed to the importing
 * admin and labelled `source='migration'`; the file's author/dates are kept only as `original_metadata`.
 */

const RACE_MESSAGE = 'Some rows collided with timesheet data saved while the batch ran. Nothing in this batch was imported — validate the file again and retry.';

/** Validate entry rows against existing data (one batch — the client splits files). Nothing is written. */
export async function validateMigrationData(rows: MigrationEntryRow[]): Promise<ActionResult<MigrationValidationResult[]>> {
  return userAction(async () => {
    await requireAdminFresh();
    assertMigrationBatchWithinLimits(rows, (r) => r.employeeEmail ?? '');
    return validateMigrationDataInternal(await getDb(), rows);
  });
}

/** Validate period-status rows (one batch). Nothing is written. */
export async function validateMigrationPeriods(rows: MigrationPeriodRow[]): Promise<ActionResult<MigrationPeriodValidationResult[]>> {
  return userAction(async () => {
    await requireAdminFresh();
    assertMigrationBatchWithinLimits(rows, (r) => r.employeeEmail ?? '');
    return validateMigrationPeriodsInternal(await getDb(), rows);
  });
}

function batchInput(input: { sourceSystem: string; fileName?: string | null }) {
  return {
    sourceSystem: validateStringLength(validateRequired(input.sourceSystem, 'Source system'), 'Source system', 1, 100),
    fileName: input.fileName?.trim() ? input.fileName.trim().slice(0, 255) : null,
  };
}

async function lockEmployees(tx: DbTx, userIds: Iterable<string>): Promise<string[]> {
  const sorted = [...new Set(userIds)].sort();
  for (const id of sorted) await lockEmployeeTimesheet(tx, id); // stable order → no lock-order deadlock between batches
  return sorted;
}

/** Import one batch of timesheet-entry rows (the client splits files: ≤ 2,000 rows, ≤ 200 employees, ~800 KB). */
export async function importMigrationData(input: {
  rows: MigrationEntryRow[];
  sourceSystem: string;
  fileName?: string | null;
}): Promise<ActionResult<MigrationResult>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    const { sourceSystem, fileName } = batchInput(input);
    const rows = input.rows ?? [];
    assertMigrationBatchWithinLimits(rows, (r) => r.employeeEmail ?? '');
    const tenant = await getTenantOrThrow();
    const today = await getWorkspaceToday();

    try {
      return await db.transaction(async (tx) => {
        await lockImportWindowExclusive(tx);
        await assertImportWindowOpen(tx, tenant.id, new Date());

        const validated = await validateMigrationDataInternal(tx, rows);
        const errors = validated.filter((v) => !v.isValid).map((v) => ({ row: v.rowIndex, message: v.errors.join('; ') }));
        const candidates: EntryCandidate[] = validated.filter((v) => v.isValid).map((v) => ({
          rowIndex: v.rowIndex,
          userId: v.userId!,
          clinId: v.clinId ?? null,
          indirectCodeId: v.indirectCodeId ?? null,
          entryDate: parseCalendarDate(v.data.entryDate.trim()),
          hours: parseImportHours(v.data.hours)!, // validated above (F3: never parseFloat-truncated)
        }));
        if (candidates.length === 0) return { imported: 0, skipped: 0, errors, batchId: null };

        const userIds = await lockEmployees(tx, candidates.map((c) => c.userId));
        const dates = candidates.map((c) => c.entryDate);
        const minDay = dates.reduce((a, b) => (isBefore(b, a) ? b : a));
        const maxDay = dates.reduce((a, b) => (isAfter(b, a) ? b : a));
        const clinIds = [...new Set(candidates.flatMap((c) => (c.clinId ? [c.clinId] : [])))];
        const indirectIds = [...new Set(candidates.flatMap((c) => (c.indirectCodeId ? [c.indirectCodeId] : [])))];
        const codeMatch = [
          ...(clinIds.length ? [inArray(timesheetEntries.clinId, clinIds)] : []),
          ...(indirectIds.length ? [inArray(timesheetEntries.indirectCodeId, indirectIds)] : []),
        ];

        const existing = await tx
          .select({ userId: timesheetEntries.userId, clinId: timesheetEntries.clinId, indirectCodeId: timesheetEntries.indirectCodeId, entryDate: timesheetEntries.entryDate })
          .from(timesheetEntries)
          .where(and(inArray(timesheetEntries.userId, userIds), between(timesheetEntries.entryDate, minDay, maxDay), or(...codeMatch)));
        const lockedRows = await tx
          .select({ userId: timesheetPeriods.userId, periodStart: timesheetPeriods.periodStart, status: timesheetPeriods.status, periodNumDays: timesheetPeriods.periodNumDays })
          .from(timesheetPeriods)
          .where(and(
            inArray(timesheetPeriods.userId, userIds),
            inArray(timesheetPeriods.status, ['submitted', 'approved']),
            gte(timesheetPeriods.periodStart, addDays(minDay, -31)), // no period is longer than 31 days
            lte(timesheetPeriods.periodStart, maxDay),
          ));
        const locked = [];
        for (const p of lockedRows) {
          const start = p.periodStart as CalendarDate;
          const numDays = p.periodNumDays ?? getNumDaysInPeriod(start, await configAt(tx, start));
          locked.push({ userId: p.userId, start, end: addDays(start, numDays - 1), status: p.status });
        }

        const plan = planEntryImport(candidates, {
          today,
          existing: existing.map((e) => ({ ...e, entryDate: e.entryDate as CalendarDate })),
          locked,
        });
        const allErrors = [...errors, ...plan.errors].sort((a, b) => a.row - b.row);
        if (plan.accepted.length === 0) return { imported: 0, skipped: 0, errors: allErrors, batchId: null };

        // The batch row first, with the final counts; then the rows that reference it (plain FKs).
        const [batch] = await tx.insert(importBatches).values({
          kind: 'entries', sourceSystem, importedBy: actor.id, fileName,
          rowCount: rows.length, importedCount: plan.accepted.length, skippedCount: rows.length - plan.accepted.length,
        }).returning({ id: importBatches.id });

        const byRow = new Map(validated.map((v) => [v.rowIndex, v.data]));
        const values = plan.accepted.map((c) => {
          const file = byRow.get(c.rowIndex)!;
          const comment = file.comment?.trim() || null;
          return {
            userId: c.userId,
            clinId: c.clinId,
            indirectCodeId: c.indirectCodeId,
            entryDate: c.entryDate,
            hours: c.hours.toString(),
            revisionNumber: 1,
            changeReasonCode: 'MIGRATION', // system-only (not in REASON_CODES, so saveTimesheetBatch rejects it)
            comment: comment ?? `Imported from ${sourceSystem}`,
            createdBy: actor.id, // createdAt = DB now (column default)
            source: 'migration',
            importBatchId: batch.id,
            originalMetadata: {
              enteredBy: file.enteredBy?.trim() || null,
              enteredAt: file.createdAt?.trim() || null,
              reason: file.changeReason?.trim() || null,
              comment,
            },
          };
        });
        for (let i = 0; i < values.length; i += MIGRATION_INSERT_CHUNK) {
          await tx.insert(timesheetEntries).values(values.slice(i, i + MIGRATION_INSERT_CHUNK));
        }
        return { imported: values.length, skipped: 0, errors: allErrors, batchId: batch.id };
      });
    } catch (err) {
      // Pre-checked under the locks, so a collision means something unexpected — the whole batch rolled back.
      if (isUniqueViolation(err)) throw new ConflictError(RACE_MESSAGE);
      throw err;
    }
  });
}

/** Import one batch of period-status rows. Import entries FIRST: entries can't be imported into a submitted/approved period. */
export async function importMigrationPeriods(input: {
  rows: MigrationPeriodRow[];
  sourceSystem: string;
  fileName?: string | null;
}): Promise<ActionResult<MigrationResult>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    const { sourceSystem, fileName } = batchInput(input);
    const rows = input.rows ?? [];
    assertMigrationBatchWithinLimits(rows, (r) => r.employeeEmail ?? '');
    const tenant = await getTenantOrThrow();
    const today = await getWorkspaceToday();

    // Employee + pay-schedule resolution reads the schedule on its own connection, so it runs before the transaction
    // (never a second connection while holding the locks).
    const validated = await validateMigrationPeriodsInternal(db, rows);
    const numDaysFor = new Map<string, Awaited<ReturnType<typeof resolvePeriod>>>();
    for (const v of validated.filter((r) => r.isValid)) {
      const start = parseCalendarDate(v.data.periodStart.trim());
      if (!numDaysFor.has(start)) numDaysFor.set(start, await resolvePeriod(start));
    }
    const errors = validated.filter((v) => !v.isValid).map((v) => ({ row: v.rowIndex, message: v.errors.join('; ') }));
    const candidates: PeriodCandidate[] = validated.filter((v) => v.isValid).map((v) => {
      const periodStart = parseCalendarDate(v.data.periodStart.trim());
      return { rowIndex: v.rowIndex, userId: v.userId!, periodStart, numDays: numDaysFor.get(periodStart)!.numDays, status: v.data.status };
    });

    try {
      return await db.transaction(async (tx) => {
        await lockImportWindowExclusive(tx);
        await assertImportWindowOpen(tx, tenant.id, new Date());
        if (candidates.length === 0) return { imported: 0, skipped: 0, errors, batchId: null };

        const userIds = await lockEmployees(tx, candidates.map((c) => c.userId));
        const starts = [...new Set(candidates.map((c) => c.periodStart))];
        const existingRows = await tx
          .select({ id: timesheetPeriods.id, userId: timesheetPeriods.userId, periodStart: timesheetPeriods.periodStart })
          .from(timesheetPeriods)
          .where(and(inArray(timesheetPeriods.userId, userIds), inArray(timesheetPeriods.periodStart, starts)));
        const sources = existingRows.length === 0 ? [] : await tx
          .select({
            periodId: periodEvents.periodId,
            migration: sql<boolean>`bool_or(${periodEvents.source} = 'migration')`,
            app: sql<boolean>`bool_or(${periodEvents.source} <> 'migration')`,
          })
          .from(periodEvents)
          .where(inArray(periodEvents.periodId, existingRows.map((r) => r.id)))
          .groupBy(periodEvents.periodId);
        const sourceOf = new Map(sources.map((s) => [s.periodId, s]));
        const ends = candidates.map((c) => addDays(c.periodStart, c.numDays - 1));
        const minStart = starts.reduce((a, b) => (isBefore(b as CalendarDate, a as CalendarDate) ? b : a)) as CalendarDate;
        const maxEnd = ends.reduce((a, b) => (isAfter(b, a) ? b : a));
        const appEntryDays = await tx
          .selectDistinct({ userId: timesheetEntries.userId, entryDate: timesheetEntries.entryDate })
          .from(timesheetEntries)
          .where(and(inArray(timesheetEntries.userId, userIds), eq(timesheetEntries.source, 'app'), between(timesheetEntries.entryDate, minStart, maxEnd)));

        const plan = planPeriodImport(candidates, {
          today,
          existing: existingRows.map((r) => {
            const s = sourceOf.get(r.id);
            // Imported = at least one migration event and no app event (legacy periods with no events are app periods).
            return { userId: r.userId, periodStart: r.periodStart as CalendarDate, imported: !!s?.migration && !s?.app };
          }),
          appEntryDays: appEntryDays.map((d) => ({ userId: d.userId, entryDate: d.entryDate as CalendarDate })),
        });
        const allErrors = [...errors, ...plan.errors].sort((a, b) => a.row - b.row);
        if (plan.accepted.length === 0) return { imported: 0, skipped: plan.skipped.length, errors: allErrors, batchId: null };

        const [batch] = await tx.insert(importBatches).values({
          kind: 'periods', sourceSystem, importedBy: actor.id, fileName,
          rowCount: rows.length, importedCount: plan.accepted.length, skippedCount: rows.length - plan.accepted.length,
        }).returning({ id: importBatches.id });

        const byRow = new Map(validated.map((v) => [v.rowIndex, v.data]));
        const inserted: Array<{ id: string; userId: string; periodStart: string }> = [];
        for (let i = 0; i < plan.accepted.length; i += MIGRATION_INSERT_CHUNK) {
          const chunk = plan.accepted.slice(i, i + MIGRATION_INSERT_CHUNK);
          inserted.push(...await tx.insert(timesheetPeriods).values(chunk.map((c) => ({
            userId: c.userId,
            periodStart: c.periodStart,
            periodType: numDaysFor.get(c.periodStart)!.config.periodType,
            periodNumDays: c.numDays,
            status: c.status,
            // Never attributed to a CadenzPoint user: the original reviewer/dates live in the events' original_metadata.
            reviewedBy: null, submittedAt: null, reviewedAt: null, reviewComment: null, submittedComment: null,
          }))).returning({ id: timesheetPeriods.id, userId: timesheetPeriods.userId, periodStart: timesheetPeriods.periodStart }));
        }
        const idFor = new Map(inserted.map((p) => [`${p.userId}|${p.periodStart}`, p.id]));
        const submittedAt = new Date();
        const decidedAt = new Date(submittedAt.getTime() + 1); // keeps submitted → decision order on created_at
        const events = plan.accepted.flatMap((c) => {
          const file = byRow.get(c.rowIndex)!;
          const base = {
            periodId: idFor.get(`${c.userId}|${c.periodStart}`)!,
            userId: c.userId,
            actorId: actor.id, // the importing admin (the export's actor_id description says so)
            source: 'migration',
            importBatchId: batch.id,
            originalMetadata: {
              reviewer: file.reviewedByEmail?.trim() || null,
              submittedAt: file.submittedAt?.trim() || null,
              reviewedAt: file.reviewedAt?.trim() || null,
              comment: file.reviewComment?.trim() || null,
            },
          };
          const submitted = { ...base, event: 'submitted' as const, createdAt: submittedAt };
          return c.status === 'submitted' ? [submitted] : [submitted, { ...base, event: c.status, createdAt: decidedAt }];
        });
        for (let i = 0; i < events.length; i += MIGRATION_INSERT_CHUNK) {
          await tx.insert(periodEvents).values(events.slice(i, i + MIGRATION_INSERT_CHUNK));
        }
        return { imported: plan.accepted.length, skipped: plan.skipped.length, errors: allErrors, batchId: batch.id };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(RACE_MESSAGE);
      throw err;
    }
  });
}
