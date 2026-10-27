import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-dated-rates.md D1 / §9 — unit rows: Pure, DR-2 (reason input), Validation, the action state checks
 * (scripted DB), Atomicity (log through the one writer inside the transaction), No silent edit, Import, Static (rates),
 * Export. The SQL-level rows (SQL = TS, Pricing, Correction, Removal, Grouping, Unpriced, Impact, Concurrency,
 * Duplicate mapping, real rollback) are in integration/dated-rates.test.ts.
 */

const h = vi.hoisted(() => ({ logThrows: false, logged: [] as unknown[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb() as ReturnType<typeof createFakeControlDb> & { transaction: (cb: (tx: unknown) => unknown) => unknown };
  db.transaction = async (cb) => cb(db);
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'adm', email: 'a@x', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});
vi.mock('@/server/internal/admin-change-log', () => ({
  logAdminChange: vi.fn(async (_tx: unknown, row: unknown) => {
    if (h.logThrows) throw new Error('log write failed');
    h.logged.push(row);
    return 'log-1';
  }),
}));

import * as dbModule from '@/db';
import { contracts, clins, laborCategories, laborCategoryRates, timesheetEntries } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import {
  addedPeriod, normalizeReason, periodBounds, rateDisplay, rateOn, sameRate, validateAddInput, validateCorrectInput, validateRemoveInput,
  type RateSchedule,
} from '@/lib/labor-rates';
import { addLaborCategoryRateChange, correctLaborCategoryRate, previewRateChangeImpact, removeLaborCategoryRateChange } from '@/server/actions/labor-category-rates';
import { updateLaborCategory } from '@/server/actions/labor-categories';
import { bulkImportLaborCategories } from '@/server/actions/import';
import { EXPORT_TABLES } from '@/lib/export/allowlists';
import type { CalendarDate } from '@/lib/calendar-date';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
const d = (s: string) => s as CalendarDate;
const L = '11111111-1111-4111-8111-111111111111';
const X1 = '22222222-2222-4222-8222-222222222222';
const X2 = '33333333-3333-4333-8333-333333333333';
beforeEach(() => { db.reset(); h.logThrows = false; h.logged = []; });

const schedule: RateSchedule = {
  starting: { hourlyRate: '100.00', ceilingRate: '150.00' },
  // deliberately out of order
  changes: [
    { id: X2, effectiveDate: d('2027-04-01'), hourlyRate: '120.00', ceilingRate: null },
    { id: X1, effectiveDate: d('2027-01-01'), hourlyRate: '110.00', ceilingRate: '160.00' },
  ],
};

describe('Pure — rateOn / periodBounds / sameRate / rateDisplay / addedPeriod', () => {
  it('rateOn: before, on and after each change (inclusive), changes in any order, no changes', () => {
    expect(rateOn(schedule, d('2026-12-31'))).toEqual({ hourlyRate: '100.00', ceilingRate: '150.00', source: 'starting' });
    expect(rateOn(schedule, d('2027-01-01'))).toEqual({ hourlyRate: '110.00', ceilingRate: '160.00', source: X1 });
    expect(rateOn(schedule, d('2027-03-31'))).toEqual({ hourlyRate: '110.00', ceilingRate: '160.00', source: X1 });
    expect(rateOn(schedule, d('2027-04-01'))).toEqual({ hourlyRate: '120.00', ceilingRate: null, source: X2 });
    expect(rateOn(schedule, d('2030-01-01'))).toMatchObject({ hourlyRate: '120.00', source: X2 });
    expect(rateOn({ starting: schedule.starting, changes: [] }, d('2030-01-01'))).toEqual({ hourlyRate: '100.00', ceilingRate: '150.00', source: 'starting' });
    // Same schedule, changes in the OTHER order: the latest applicable change still wins (not the first match).
    const ascending = { ...schedule, changes: [...schedule.changes].reverse() };
    expect(rateOn(ascending, d('2030-01-01'))).toMatchObject({ hourlyRate: '120.00', source: X2 });
    expect(rateOn(ascending, d('2027-04-01'))).toMatchObject({ hourlyRate: '120.00', source: X2 });
  });

  it('periodBounds: starting / middle / last; an unknown id throws', () => {
    expect(periodBounds(schedule, 'starting')).toEqual({ from: null, toExclusive: '2027-01-01' });
    expect(periodBounds(schedule, X1)).toEqual({ from: '2027-01-01', toExclusive: '2027-04-01' });
    expect(periodBounds(schedule, X2)).toEqual({ from: '2027-04-01', toExclusive: null });
    expect(periodBounds({ starting: schedule.starting, changes: [] }, 'starting')).toEqual({ from: null, toExclusive: null });
    expect(() => periodBounds(schedule, 'nope')).toThrow(/unknown change/);
  });

  it('addedPeriod: [D, the next change after D)', () => {
    expect(addedPeriod(schedule, d('2027-02-15'))).toEqual({ from: '2027-02-15', toExclusive: '2027-04-01' });
    expect(addedPeriod(schedule, d('2028-01-01'))).toEqual({ from: '2028-01-01', toExclusive: null });
    expect(addedPeriod(schedule, d('2026-06-01'))).toEqual({ from: '2026-06-01', toExclusive: '2027-01-01' });
  });

  it('sameRate compares numbers at 2 decimals; unparseable never equal', () => {
    expect(sameRate('145', '145.00')).toBe(true);
    expect(sameRate('145', '$145')).toBe(false);
    expect(sameRate(null, null)).toBe(true);
    expect(sameRate('1', null)).toBe(false);
    expect(sameRate('110.004', '110.00')).toBe(true);
  });

  it('rateDisplay: current + next (today 2027-02-01 → 110.00 / next 2027-04-01 120.00; today 2026-12-31 → 100.00)', () => {
    expect(rateDisplay(schedule, d('2027-02-01'))).toEqual({ current: { hourlyRate: '110.00', ceilingRate: '160.00' }, next: schedule.changes[0] });
    expect(rateDisplay(schedule, d('2026-12-31'))).toMatchObject({ current: { hourlyRate: '100.00' }, next: { id: X1 } });
    expect(rateDisplay(schedule, d('2030-01-01')).next).toBeNull();
  });
});

describe('DR-2 (reason input) and Validation (pure)', () => {
  it('normalizeReason: null / undefined / "" / "   " → null; text kept; 501 characters refused', () => {
    for (const r of [null, undefined, '', '   ']) expect(normalizeReason(r)).toBeNull();
    expect(normalizeReason('typo')).toBe('typo');
    expect(() => normalizeReason('x'.repeat(501))).toThrow('Reason must not exceed 500 characters.');
  });

  it('ids, dates, rates — exact messages', () => {
    const add = (o: Record<string, unknown>) => () => validateAddInput({ laborCategoryId: L, effectiveDate: '2027-01-01', hourlyRate: '110', ceilingRate: null, ...o } as never);
    expect(add({ effectiveDate: '2027-02-30' })).toThrow('Effective date is not a valid date.');
    expect(add({ effectiveDate: undefined })).toThrow('Effective date is not a valid date.');
    expect(add({ hourlyRate: '-1' })).toThrow('Hourly rate cannot be negative.');
    expect(add({ hourlyRate: 'abc' })).toThrow('Hourly rate must be a valid number.');
    expect(add({ ceilingRate: 'abc' })).toThrow('Ceiling rate must be a valid number.');
    expect(add({ laborCategoryId: 'not-a-uuid' })).toThrow('Labor category is not a valid identifier.');
    expect(add({}) ()).toMatchObject({ hourlyRate: '110.00', ceilingRate: null, reason: null });
    expect(add({ ceilingRate: '' })().ceilingRate).toBeNull();
    expect(() => validateCorrectInput({ laborCategoryId: L, target: 'bogus', hourlyRate: '1', ceilingRate: null })).toThrow('Rate period is not a valid identifier.');
    expect(validateCorrectInput({ laborCategoryId: L, target: 'starting', hourlyRate: '1', ceilingRate: null }).target).toBe('starting');
    expect(() => validateRemoveInput({ laborCategoryId: L, changeId: 'starting' })).toThrow('Rate period is not a valid identifier.');
  });
});

// ── Actions with a scripted database ───────────────────────────────────────────────────────────────────────────
/** Script the in-transaction reads: the locked category, its changes, the re-priced hours; then the view reads. */
function facts(o: { starting?: [string, string | null] | null; changes?: RateSchedule['changes']; hours?: string }) {
  if (o.starting === null) { db.onSelect(laborCategories, []); return; }
  const [hr, ce] = o.starting ?? ['100.00', '150.00'];
  db.onSelect(laborCategories, [{ hourlyRate: hr, ceilingRate: ce }]);
  db.onSelect(laborCategoryRates, (o.changes ?? []) as never);
  if (o.hours !== undefined) db.onSelect(timesheetEntries, [{ hours: o.hours }]);
  db.onSelect(laborCategories, [{ hourlyRate: hr, ceilingRate: ce }]); // view
  db.onSelect(laborCategoryRates, (o.changes ?? []) as never);
}
const writes = () => [...db.inserts, ...db.updates, ...db.deletes];

describe('state checks (exact messages, first failure wins, nothing written)', () => {
  const addIn = (o: Record<string, unknown> = {}) => ({ laborCategoryId: L, effectiveDate: '2027-01-01', hourlyRate: '110.00', ceilingRate: null, ...o }) as never;

  it('category missing → not_found', async () => {
    facts({ starting: null });
    expect(await addLaborCategoryRateChange(addIn())).toEqual({ ok: false, code: 'not_found', error: 'Labor category not found.' });
    expect(writes()).toEqual([]);
  });

  it('add on a date that already has a change → conflict, date-specific message', async () => {
    facts({ changes: [{ id: X1, effectiveDate: d('2027-01-01'), hourlyRate: '110.00', ceilingRate: null }] });
    expect(await addLaborCategoryRateChange(addIn({ hourlyRate: '115' }))).toEqual({
      ok: false, code: 'conflict', error: 'There is already a rate change on 2027-01-01 for this labor category. Correct that one instead.',
    });
    expect(writes()).toEqual([]);
  });

  it('add with the values already in effect ("110" vs stored "110.00") → refused', async () => {
    facts({ changes: [{ id: X1, effectiveDate: d('2026-06-01'), hourlyRate: '110.00', ceilingRate: null }] });
    expect(await addLaborCategoryRateChange(addIn({ hourlyRate: '110' }))).toEqual({ ok: false, code: 'validation', error: 'That is already the rate in effect on 2027-01-01.' });
    expect(writes()).toEqual([]);
  });

  it('DR-2: re-prices hours without a reason → refused, nothing written, no log row', async () => {
    facts({ hours: '12.00' });
    expect(await addLaborCategoryRateChange(addIn())).toEqual({ ok: false, code: 'validation', error: 'A reason is required because this change re-prices recorded hours.' });
    expect(writes()).toEqual([]);
    expect(h.logged).toEqual([]);
  });

  it('DR-2: zero impact needs no reason; "" and "   " count as no reason; the log row records reason null', async () => {
    for (const reason of [undefined, '', '   ']) {
      db.reset(); h.logged = [];
      facts({ hours: '0.00' });
      db.onReturning('insert', laborCategoryRates, [{ id: 'new' }]);
      const r = await addLaborCategoryRateChange(addIn({ effectiveDate: '2028-01-01', reason }));
      expect(r.ok, String(reason)).toBe(true);
      expect(h.logged).toEqual([expect.objectContaining({ action: 'rate_change_added', newValue: expect.objectContaining({ reason: null, repricedHours: '0.00' }) })]);
    }
  });

  it('add writes the change (createdBy = actor) and one log row: old = rateOn before, new = values + reason + repricedHours', async () => {
    facts({ hours: '12.00' });
    db.onReturning('insert', laborCategoryRates, [{ id: 'new' }]);
    expect((await addLaborCategoryRateChange(addIn({ reason: 'option year' }))).ok).toBe(true);
    expect(db.inserts.find((i) => i.table === laborCategoryRates)!.values).toEqual({ laborCategoryId: L, effectiveDate: '2027-01-01', hourlyRate: '110.00', ceilingRate: null, createdBy: 'adm' });
    expect(h.logged).toEqual([{
      actorId: 'adm', entity: 'labor_category_rate', entityId: L, action: 'rate_change_added',
      oldValue: { source: 'starting', hourlyRate: '100.00', ceilingRate: '150.00' },
      newValue: { effectiveDate: '2027-01-01', hourlyRate: '110.00', ceilingRate: null, reason: 'option year', repricedHours: '12.00' },
    }]);
  });

  it('correct: identical values → "Nothing to correct"; another category\'s / a gone period → not_found', async () => {
    facts({});
    expect(await correctLaborCategoryRate({ laborCategoryId: L, target: 'starting', hourlyRate: '100', ceilingRate: '150' })).toEqual({ ok: false, code: 'validation', error: 'Nothing to correct — the values are unchanged.' });
    db.reset();
    facts({});
    expect(await correctLaborCategoryRate({ laborCategoryId: L, target: X1, hourlyRate: '105', ceilingRate: null })).toEqual({ ok: false, code: 'not_found', error: 'That rate period no longer exists. Refresh and try again.' });
    expect(writes()).toEqual([]);
  });

  it('correct starting: updates labor_categories and logs period + repricedHours', async () => {
    facts({ changes: [{ id: X1, effectiveDate: d('2027-01-01'), hourlyRate: '110.00', ceilingRate: null }], hours: '8.00' });
    db.onReturning('update', laborCategories, [{ id: L }]);
    expect((await correctLaborCategoryRate({ laborCategoryId: L, target: 'starting', hourlyRate: '105', ceilingRate: '150', reason: 'typo' })).ok).toBe(true);
    expect(db.updates[0]).toMatchObject({ table: laborCategories, set: { hourlyRate: '105.00', ceilingRate: '150.00' } });
    expect(h.logged).toEqual([expect.objectContaining({
      action: 'rate_corrected', oldValue: { target: 'starting', hourlyRate: '100.00', ceilingRate: '150.00' },
      newValue: { target: 'starting', hourlyRate: '105.00', ceilingRate: '150.00', reason: 'typo', period: { from: null, toExclusive: '2027-01-01' }, repricedHours: '8.00' },
    })]);
  });

  it('correct: an empty .returning() (row gone meanwhile) → not_found', async () => {
    facts({ changes: [{ id: X1, effectiveDate: d('2027-01-01'), hourlyRate: '110.00', ceilingRate: null }], hours: '0.00' });
    expect(await correctLaborCategoryRate({ laborCategoryId: L, target: X1, hourlyRate: '112', ceilingRate: null })).toEqual({ ok: false, code: 'not_found', error: 'That rate period no longer exists. Refresh and try again.' });
    expect(h.logged).toEqual([]);
  });

  it('remove: another category\'s change → not_found; removes and logs the removed values', async () => {
    facts({});
    expect(await removeLaborCategoryRateChange({ laborCategoryId: L, changeId: X1 })).toMatchObject({ ok: false, code: 'not_found' });
    db.reset();
    facts({ changes: [{ id: X2, effectiveDate: d('2027-04-01'), hourlyRate: '120.00', ceilingRate: null }], hours: '4.00' });
    db.onReturning('delete', laborCategoryRates, [{ id: X2 }]);
    expect((await removeLaborCategoryRateChange({ laborCategoryId: L, changeId: X2, reason: 'wrong date' })).ok).toBe(true);
    expect(h.logged).toEqual([expect.objectContaining({
      action: 'rate_change_removed', oldValue: { effectiveDate: '2027-04-01', hourlyRate: '120.00', ceilingRate: null }, newValue: { reason: 'wrong date', repricedHours: '4.00' },
    })]);
  });

  it('preview: hours, period and reasonRequired; validates without a reason; same not_found rules', async () => {
    db.onSelect(laborCategories, [{ hourlyRate: '100.00', ceilingRate: null }]);
    db.onSelect(laborCategoryRates, []);
    db.onSelect(timesheetEntries, [{ hours: '12.00' }]);
    expect(await previewRateChangeImpact({ kind: 'add', laborCategoryId: L, effectiveDate: '2027-01-01', hourlyRate: '110', ceilingRate: null, reason: 'x'.repeat(900) }))
      .toEqual({ ok: true, data: { hours: '12.00', from: '2027-01-01', toExclusive: null, reasonRequired: true } });
    db.reset();
    db.onSelect(laborCategories, [{ hourlyRate: '100.00', ceilingRate: null }]);
    db.onSelect(laborCategoryRates, []);
    expect(await previewRateChangeImpact({ kind: 'remove', laborCategoryId: L, changeId: X1 })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('Atomicity — the log row is written through the one writer, inside the transaction', () => {
  it('a failing log write fails the action (inside the transaction — the real rollback is proven on Postgres)', async () => {
    h.logThrows = true;
    facts({ hours: '0.00' });
    db.onReturning('insert', laborCategoryRates, [{ id: 'new' }]);
    await expect(addLaborCategoryRateChange({ laborCategoryId: L, effectiveDate: '2028-01-01', hourlyRate: '110', ceilingRate: null })).rejects.toThrow('log write failed');
  });

  it('static: every mutation calls logAdminChange(tx, …) inside db.transaction, before returning', () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/server/actions/labor-category-rates.ts'), 'utf8'));
    for (const fn of ['addLaborCategoryRateChange', 'correctLaborCategoryRate', 'removeLaborCategoryRateChange']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const tx = body.slice(body.indexOf('db.transaction(async (tx) => {'), body.indexOf('return view(tx'));
      expect(tx, fn).toMatch(/await logAdminChange\(tx, \{/);
      expect(body.indexOf('await requireAdminFresh()'), fn).toBeLessThan(body.indexOf('await getDbForWrite()'));
      expect(body, fn).toMatch(/\.for\('no key update'\)|lockAndReadSchedule\(tx, v\.laborCategoryId\)/);
    }
    expect(readFileSync(path.join(ROOT, 'src/server/internal/labor-rates.ts'), 'utf8')).toMatch(/\.for\('no key update'\)/);
  });
});

describe('No silent edit, Import', () => {
  it('updateLaborCategory ignores an hourlyRate / ceilingRate key (rates change only through the rate actions)', async () => {
    db.onReturning('update', laborCategories, [{ id: L }]);
    expect((await updateLaborCategory(L, { title: 'T', hourlyRate: '999', ceilingRate: '999' } as never)).ok).toBe(true);
    expect(db.updates[0].set).not.toHaveProperty('hourlyRate');
    expect(db.updates[0].set).not.toHaveProperty('ceilingRate');
  });

  it('bulk import: hourly "$145" or blank is a row error (validator message), nothing inserted; "  " ceiling = none', async () => {
    const row = (o: Record<string, string>) => ({ contractNumber: 'K', clinNumber: '0001', lcatCode: 'L', title: 'T', hourlyRate: '145', ceilingRate: '', ...o });
    for (let i = 0; i < 3; i++) { db.onSelect(contracts, [{ id: 'k' }]); db.onSelect(clins, [{ id: 'c' }]); }
    const r = await bulkImportLaborCategories([row({ hourlyRate: '$145' }), row({ hourlyRate: '' }), row({ ceilingRate: '  ' })]);
    expect(r).toMatchObject({ ok: true, data: { created: 1, errors: [{ row: 1, message: 'Hourly rate must be a valid number.' }, { row: 2, message: 'Hourly rate cannot be empty.' }] } });
    expect(db.inserts.map((i) => i.values)).toEqual([expect.objectContaining({ hourlyRate: '145.00', ceilingRate: undefined })]);
  });
});

// ── Static (rates) ─────────────────────────────────────────────────────────────────────────────────────────────
const RATE_ALLOWED = new Set([
  'src/db/schema.ts', 'src/server/internal/labor-rates.ts', 'src/server/actions/labor-categories.ts', 'src/server/actions/labor-category-rates.ts',
  'src/server/actions/import.ts', 'src/lib/export/allowlists.ts', 'scripts/seed-full.ts', 'scripts/report-cost-basis-change.ts',
]);
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules' || name === 'drizzle') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
export function readsRateColumn(src: string): boolean {
  const code = stripComments(src);
  return /\b(laborCategories|laborCategoryRates)\.(hourlyRate|ceilingRate)\b/.test(code)
    || /\b(hourly_rate|ceiling_rate)\b/.test(code)
    || /\b\w+LaborCategory\.hourlyRate\b/.test(code);
}

describe('Static (rates): only the rate rule and the rate writers read a rate column', () => {
  it('no src/ or scripts/ file outside the allowed list matches a rate column', () => {
    const offenders = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'scripts'))]
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => !RATE_ALLOWED.has(rel) && readsRateColumn(readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('fixtures: each pattern is flagged; cost-basis no longer reads a rate column', () => {
    expect(readsRateColumn('select({ r: laborCategories.hourlyRate })')).toBe(true);
    expect(readsRateColumn('select({ r: laborCategoryRates.ceilingRate })')).toBe(true);
    expect(readsRateColumn('sql`CAST("cost_lc"."hourly_rate" AS NUMERIC)`')).toBe(true);
    expect(readsRateColumn('select({ r: costLaborCategory.hourlyRate })')).toBe(true);
    expect(readsRateColumn("accessorKey: 'hourlyRate'")).toBe(false);
    expect(readsRateColumn(readFileSync(path.join(ROOT, 'src/server/internal/cost-basis.ts'), 'utf8'))).toBe(false);
  });
});

describe('Seed (D1.7, static; seed-conformance runs it on Postgres)', () => {
  it('NAV-01 SE-III gets one change two months back (hard-coded 149.35 / 164.80) and its log row through logAdminChange', () => {
    const seed = stripComments(readFileSync(path.join(ROOT, 'scripts/seed-full.ts'), 'utf8'));
    expect(seed).toMatch(/const escalationDate = addMonths\(startOfMonth\(todayIn\('America\/New_York'\)\), -2\);/);
    expect(seed).toMatch(/laborCategoryId: seIII, effectiveDate: escalationDate, hourlyRate: '149\.35', ceilingRate: '164\.80', createdBy: userIds\.admin/);
    expect(seed).toMatch(/await logAdminChange\(tx as never, \{[\s\S]*?action: 'rate_change_added'[\s\S]*?reason: 'Demo: option-year escalation', repricedHours: null/);
    expect(seed).not.toMatch(/getWorkspaceToday/);
  });
});

describe('Export, cleanup, duplicate key', () => {
  it('labor_category_rates is exported with every column described; starting-rate descriptions reworded', () => {
    const t = EXPORT_TABLES.find((x) => x.file === 'labor_category_rates')!;
    expect(t.columns.map((c) => c.header)).toEqual(['id', 'labor_category_id', 'effective_date', 'hourly_rate', 'ceiling_rate', 'created_by', 'created_at', 'updated_at']);
    expect(t.columns.find((c) => c.header === 'effective_date')!.description).toBe('First day this rate applies (inclusive); it applies until the next change.');
    const lc = EXPORT_TABLES.find((x) => x.file === 'labor_categories')!;
    expect(lc.columns.find((c) => c.header === 'hourly_rate')!.description).toBe('Starting rate — applies to days before the first change in labor_category_rates.csv.');
  });

  it('clearTenantData deletes labor_category_rates before labor_categories', () => {
    const src = readFileSync(path.join(ROOT, 'src/db/clear-tenant-data.ts'), 'utf8');
    expect(src.indexOf('tx.delete(schema.laborCategoryRates)')).toBeGreaterThan(-1);
    expect(src.indexOf('tx.delete(schema.laborCategoryRates)')).toBeLessThan(src.indexOf('tx.delete(schema.laborCategories)'));
  });

  it('the migration has only the table, its FKs and the unique index; the key name matches the map', () => {
    const dir = path.join(ROOT, 'drizzle');
    const file = readdirSync(dir).find((f) => /^0015_.*\.sql$/.test(f))!;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    expect(sql.match(/^(CREATE TABLE|ALTER TABLE|CREATE UNIQUE INDEX|CREATE INDEX|UPDATE|INSERT|DELETE)/gm)).toEqual(['CREATE TABLE', 'ALTER TABLE', 'ALTER TABLE', 'CREATE UNIQUE INDEX']);
    expect(sql).toContain('CREATE UNIQUE INDEX "lcat_rate_effective_unique_idx" ON "labor_category_rates"');
  });
});
