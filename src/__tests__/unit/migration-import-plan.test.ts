import { describe, it, expect } from 'vitest';
import {
  MIGRATION_BATCH_MAX_BYTES,
  MIGRATION_BATCH_MAX_EMPLOYEES,
  MIGRATION_BATCH_MAX_ROWS,
  assertMigrationBatchWithinLimits,
  planEntryImport,
  planPeriodImport,
  splitMigrationBatches,
  type EntryCandidate,
  type PeriodCandidate,
} from '@/lib/migration/import-plan';
import { UserFacingError } from '@/lib/errors';
import type { CalendarDate } from '@/lib/calendar-date';

/**
 * feature-plan-certified-outputs.md C1 / §9: "Import guards", "Batch integrity" (in-file duplicate), "Periods import
 * dates", "Period import" (duplicates skipped, refused where app rows exist), "Batch limits". The DB facts are read
 * under the locks by the action; these are the decisions.
 */

const d = (s: string) => s as CalendarDate;
const TODAY = d('2026-10-25');
const entry = (o: Partial<EntryCandidate> = {}): EntryCandidate => ({
  rowIndex: 1, userId: 'u1', clinId: 'clinA', indirectCodeId: null, entryDate: d('2026-09-02'), hours: 8, ...o,
});
const noFacts = { today: TODAY, existing: [], locked: [] };

describe('planEntryImport', () => {
  it('a valid past row is accepted', () => {
    expect(planEntryImport([entry()], noFacts)).toEqual({ accepted: [entry()], errors: [] });
  });

  it('today and future dates are refused', () => {
    const r = planEntryImport([entry({ entryDate: TODAY }), entry({ rowIndex: 2, entryDate: d('2026-11-01') })], noFacts);
    expect(r.accepted).toEqual([]);
    expect(r.errors.map((e) => e.row)).toEqual([1, 2]);
    for (const e of r.errors) expect(e.message).toMatch(/must be before today/);
  });

  it('a date inside ANY submitted or approved period is refused (imported, app or legacy — whatever its source)', () => {
    const locked = [
      { userId: 'u1', start: d('2026-09-01'), end: d('2026-09-15'), status: 'approved' },
      { userId: 'u1', start: d('2026-09-16'), end: d('2026-09-30'), status: 'submitted' },
      { userId: 'u2', start: d('2026-08-01'), end: d('2026-08-15'), status: 'approved' }, // someone else's
    ];
    const r = planEntryImport([
      entry({ entryDate: d('2026-09-01') }),
      entry({ rowIndex: 2, entryDate: d('2026-09-30') }),
      entry({ rowIndex: 3, entryDate: d('2026-08-05') }),
    ], { ...noFacts, locked });
    expect(r.errors.map((e) => [e.row, e.message.match(/an approved|a submitted/)?.[0]])).toEqual([[1, 'an approved'], [2, 'a submitted']]);
    expect(r.accepted.map((a) => a.rowIndex)).toEqual([3]);
  });

  it('overlap guard: same CLIN that day (app charge-code rows carry clin_id) or same indirect code → refused', () => {
    const existing = [
      { userId: 'u1', clinId: 'clinA', indirectCodeId: null, entryDate: d('2026-09-02') },
      { userId: 'u1', clinId: null, indirectCodeId: 'oh', entryDate: d('2026-09-03') },
    ];
    const r = planEntryImport([
      entry(),
      entry({ rowIndex: 2, clinId: null, indirectCodeId: 'oh', entryDate: d('2026-09-03') }),
      entry({ rowIndex: 3, clinId: 'clinB' }),                // another CLIN that day → fine
      entry({ rowIndex: 4, userId: 'u2' }),                    // another employee → fine
    ], { ...noFacts, existing });
    expect(r.errors).toEqual([
      { row: 1, message: expect.stringMatching(/already has hours on this CLIN/) },
      { row: 2, message: expect.stringMatching(/already has hours on this indirect code/) },
    ]);
    expect(r.accepted.map((a) => a.rowIndex)).toEqual([3, 4]);
  });

  it('in-file duplicate (same employee, cell code, date) → row error naming the earlier row, not a batch failure', () => {
    const r = planEntryImport([entry(), entry({ rowIndex: 2, hours: 4 }), entry({ rowIndex: 3, entryDate: d('2026-09-03') })], noFacts);
    expect(r.errors).toEqual([{ row: 2, message: 'Duplicate of row 1 (same employee, code and date).' }]);
    expect(r.accepted.map((a) => a.rowIndex)).toEqual([1, 3]);
  });
});

const period = (o: Partial<PeriodCandidate> = {}): PeriodCandidate => ({
  rowIndex: 1, userId: 'u1', periodStart: d('2026-09-01'), numDays: 15, status: 'approved', ...o,
});
const noPeriodFacts = { today: TODAY, existing: [], appEntryDays: [] };

describe('planPeriodImport', () => {
  it('a finished submitted / approved / rejected period is accepted (status normalised)', () => {
    const r = planPeriodImport([period({ status: 'Approved' }), period({ rowIndex: 2, userId: 'u2', status: 'rejected' }), period({ rowIndex: 3, userId: 'u3', status: 'submitted' })], noPeriodFacts);
    expect(r.accepted.map((a) => a.status)).toEqual(['approved', 'rejected', 'submitted']);
    expect(r.errors).toEqual([]);
  });

  it('a period ending today or later → row error (it would lock the live timesheet forever)', () => {
    const r = planPeriodImport([
      period({ periodStart: d('2026-10-16'), numDays: 10 }),            // ends 2026-10-25 = today
      period({ rowIndex: 2, periodStart: d('2026-10-16'), numDays: 16 }), // ends 2026-10-31
      period({ rowIndex: 3, periodStart: d('2026-10-10'), numDays: 15 }), // ends 2026-10-24 → ok
    ], noPeriodFacts);
    expect(r.errors.map((e) => e.row)).toEqual([1, 2]);
    for (const e of r.errors) expect(e.message).toMatch(/has not ended yet/);
    expect(r.accepted.map((a) => a.rowIndex)).toEqual([3]);
  });

  it('draft → row error; unknown status → row error (never silently draft)', () => {
    const r = planPeriodImport([period({ status: 'draft' }), period({ rowIndex: 2, status: 'pending' })], noPeriodFacts);
    expect(r.errors[0].message).toMatch(/Draft periods are not imported/);
    expect(r.errors[1].message).toMatch(/"pending" is not importable/);
  });

  it('already imported → skipped (not counted); a non-imported period row → refused; app entries in the period → refused', () => {
    const r = planPeriodImport([
      period(),
      period({ rowIndex: 2, userId: 'u2' }),
      period({ rowIndex: 3, userId: 'u3' }),
      period({ rowIndex: 4, userId: 'u4' }),
    ], {
      today: TODAY,
      existing: [
        { userId: 'u1', periodStart: d('2026-09-01'), imported: true },
        { userId: 'u2', periodStart: d('2026-09-01'), imported: false }, // app / legacy period (no events)
      ],
      appEntryDays: [{ userId: 'u3', entryDate: d('2026-09-15') }, { userId: 'u4', entryDate: d('2026-09-16') }],
    });
    expect(r.skipped).toEqual([1]);
    expect(r.errors).toEqual([
      { row: 2, message: expect.stringMatching(/already has this period in CadenzPoint/) },
      { row: 3, message: expect.stringMatching(/hours recorded in CadenzPoint in this period \(2026-09-15\)/) },
    ]);
    expect(r.accepted.map((a) => a.rowIndex)).toEqual([4]); // 2026-09-16 is after the period
  });

  it('in-file duplicate period → row error', () => {
    const r = planPeriodImport([period(), period({ rowIndex: 2 })], noPeriodFacts);
    expect(r.errors).toEqual([{ row: 2, message: expect.stringMatching(/Duplicate of row 1/) }]);
  });
});

describe('batch limits (server-enforced) and splitting', () => {
  const row = (i: number, employees = 1) => ({ employeeEmail: `e${i % employees}@x.dev`, payload: 'x'.repeat(10) });

  it('2,001 rows → validation error; 201 employees → validation error; 2,000 rows / 200 employees accepted', () => {
    expect(() => assertMigrationBatchWithinLimits(Array.from({ length: 2001 }, (_, i) => row(i)), (r) => r.employeeEmail))
      .toThrow(new UserFacingError(`A batch can have at most ${MIGRATION_BATCH_MAX_ROWS} rows (this one has 2001). Split the file into smaller batches.`));
    expect(() => assertMigrationBatchWithinLimits(Array.from({ length: 201 }, (_, i) => row(i, 201)), (r) => r.employeeEmail))
      .toThrow(/at most 200 employees \(this one has 201\)/);
    expect(() => assertMigrationBatchWithinLimits(Array.from({ length: 2000 }, (_, i) => row(i, 200)), (r) => r.employeeEmail)).not.toThrow();
  });

  it('a large file splits into batches that each pass the server limits, in file order', () => {
    const rows = Array.from({ length: 5003 }, (_, i) => ({ employeeEmail: `e${i % 450}@x.dev`, i, pad: 'p'.repeat(150) }));
    const batches = splitMigrationBatches(rows, (r) => r.employeeEmail);
    expect(batches.flat().map((r) => r.i)).toEqual(rows.map((r) => r.i));
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(MIGRATION_BATCH_MAX_ROWS);
      expect(new Set(b.map((r) => r.employeeEmail)).size).toBeLessThanOrEqual(MIGRATION_BATCH_MAX_EMPLOYEES);
      expect(JSON.stringify(b).length).toBeLessThanOrEqual(MIGRATION_BATCH_MAX_BYTES);
      expect(() => assertMigrationBatchWithinLimits(b, (r) => r.employeeEmail)).not.toThrow();
    }
    expect(batches.length).toBeGreaterThan(2);
  });

  it('a byte-heavy file splits on size before the row limit (~800 KB per batch, under the 1 MB action limit)', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ employeeEmail: 'one@x.dev', i, pad: 'p'.repeat(1000) }));
    const batches = splitMigrationBatches(rows, (r) => r.employeeEmail);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(JSON.stringify(b).length).toBeLessThanOrEqual(MIGRATION_BATCH_MAX_BYTES);
  });

  it('a 2,000-row, ~800 KB batch stays one batch', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ employeeEmail: `e${i % 10}@x.dev`, pad: 'p'.repeat(340) }));
    const batches = splitMigrationBatches(rows, (r) => r.employeeEmail);
    expect(batches).toHaveLength(1);
    expect(JSON.stringify(batches[0]).length).toBeGreaterThan(750_000);
  });
});
