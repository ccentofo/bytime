import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-dated-rates.md D3 / §9 — unit rows: pure twin, D3 first category, D3 bad category id, D3 DR-Q2,
 * D3 no silent edit, and "D3 concurrency / atomicity / security / validation" (the unit forms). The pricing rows and
 * the Postgres forms are in integration/dated-rates-d3.test.ts.
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
import { chargeCodeLaborCategories, chargeCodes, laborCategories, timesheetEntries } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { categoryFitsCode, chargeCodeCategoryOn, validateCategoryRef, type CategorySchedule } from '@/lib/labor-rates';
import {
  addChargeCodeCategoryChange, correctChargeCodeCategory, previewChargeCodeCategoryImpact, removeChargeCodeCategoryChange,
} from '@/server/actions/charge-code-categories';
import { updateChargeCode } from '@/server/actions/charge-codes';
import { EXPORT_TABLES } from '@/lib/export/allowlists';
import type { CalendarDate } from '@/lib/calendar-date';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
const d = (s: string) => s as CalendarDate;
const K = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const X1 = '44444444-4444-4444-8444-444444444444';
beforeEach(() => { db.reset(); h.logThrows = false; h.logged = []; });

describe('pure twin and DR-Q2 placement rule', () => {
  const s: CategorySchedule = { starting: L, changes: [{ id: 'x2', effectiveDate: d('2027-06-01'), laborCategoryId: L }, { id: 'x1', effectiveDate: d('2027-03-01'), laborCategoryId: M }] };
  it('chargeCodeCategoryOn: starting before the first change, inclusive on each date, latest wins in any order, null starting', () => {
    expect(chargeCodeCategoryOn(s, d('2027-02-28'))).toEqual({ laborCategoryId: L, source: 'starting' });
    expect(chargeCodeCategoryOn(s, d('2027-03-01'))).toEqual({ laborCategoryId: M, source: 'x1' });
    expect(chargeCodeCategoryOn(s, d('2027-06-01'))).toEqual({ laborCategoryId: L, source: 'x2' });
    expect(chargeCodeCategoryOn({ ...s, changes: [...s.changes].reverse() }, d('2030-01-01'))).toMatchObject({ source: 'x2' });
    expect(chargeCodeCategoryOn({ starting: null, changes: [] }, d('2027-01-01'))).toEqual({ laborCategoryId: null, source: 'starting' });
  });

  it('categoryFitsCode: same CLIN required; SLIN must match only when both have one', () => {
    expect(categoryFitsCode({ clinId: 'c1', slinId: null }, { clinId: 'c1', slinId: null })).toBe(true);
    expect(categoryFitsCode({ clinId: 'c2', slinId: null }, { clinId: 'c1', slinId: null })).toBe(false);
    expect(categoryFitsCode({ clinId: 'c1', slinId: 's1' }, { clinId: 'c1', slinId: 's2' })).toBe(false);
    expect(categoryFitsCode({ clinId: 'c1', slinId: 's1' }, { clinId: 'c1', slinId: null })).toBe(true);
    expect(categoryFitsCode({ clinId: 'c1', slinId: null }, { clinId: 'c1', slinId: 's1' })).toBe(true);
  });

  it('D3 bad category id (pure): not-a-uuid; null on a dated change; null allowed for the starting category', () => {
    expect(() => validateCategoryRef('not-a-uuid', false)).toThrow('Labor category is not a valid identifier.');
    expect(() => validateCategoryRef(null, false)).toThrow('A dated change must name a labor category.');
    expect(validateCategoryRef(null, true)).toBeNull();
  });
});

/** In-transaction reads: the locked code, its changes, (the category placement), (the re-priced hours); then the view. */
function facts(o: { code?: { clinId: string; slinId: string | null; laborCategoryId: string | null } | null; changes?: CategorySchedule['changes']; placement?: { clinId: string; slinId: string | null } | null; hours?: string }) {
  if (o.code === null) { db.onSelect(chargeCodes, []); return; }
  const code = o.code ?? { clinId: 'c1', slinId: null, laborCategoryId: L };
  db.onSelect(chargeCodes, [code]);
  db.onSelect(chargeCodeLaborCategories, (o.changes ?? []) as never);
  if (o.placement !== undefined) db.onSelect(laborCategories, o.placement ? [o.placement] : []);
  if (o.hours !== undefined) db.onSelect(timesheetEntries, [{ hours: o.hours }]);
  db.onSelect(chargeCodes, [code]);
  db.onSelect(chargeCodeLaborCategories, (o.changes ?? []) as never);
}
const writes = () => [...db.inserts, ...db.updates, ...db.deletes];

describe('state checks (exact messages, nothing written)', () => {
  it('charge code missing → not_found', async () => {
    facts({ code: null });
    expect(await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M })).toEqual({ ok: false, code: 'not_found', error: 'Charge code not found.' });
  });

  it('D3 bad category id: a valid uuid that doesn\'t exist → not_found; not-a-uuid / null on a dated change → validation', async () => {
    facts({ placement: null });
    expect(await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M })).toEqual({ ok: false, code: 'not_found', error: 'Labor category not found.' });
    expect(await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: 'not-a-uuid' })).toEqual({ ok: false, code: 'validation', error: 'Labor category is not a valid identifier.' });
    expect(await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: null })).toEqual({ ok: false, code: 'validation', error: 'A dated change must name a labor category.' });
    expect(await correctChargeCodeCategory({ chargeCodeId: K, target: X1, laborCategoryId: null })).toEqual({ ok: false, code: 'validation', error: 'A dated change must name a labor category.' });
    expect(writes()).toEqual([]);
  });

  it('D3 DR-Q2: another CLIN, or a SLIN mismatch → refused (add and correct)', async () => {
    facts({ placement: { clinId: 'c2', slinId: null } });
    expect(await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M })).toEqual({ ok: false, code: 'validation', error: 'That labor category belongs to a different CLIN or SLIN than this charge code.' });
    db.reset();
    facts({ code: { clinId: 'c1', slinId: 's1', laborCategoryId: L }, placement: { clinId: 'c1', slinId: 's2' } });
    expect(await correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: M, reason: 'r' })).toMatchObject({ ok: false, error: /different CLIN or SLIN/ });
    expect(writes()).toEqual([]);
  });

  it('duplicate date → conflict (date-specific); the category already in effect → refused; nothing to correct', async () => {
    facts({ changes: [{ id: X1, effectiveDate: d('2027-03-01'), laborCategoryId: M }], placement: { clinId: 'c1', slinId: null } });
    expect(await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M })).toEqual({
      ok: false, code: 'conflict', error: 'There is already a category change on 2027-03-01 for this charge code. Correct that one instead.',
    });
    db.reset();
    facts({ placement: { clinId: 'c1', slinId: null } });
    expect(await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: L })).toEqual({ ok: false, code: 'validation', error: 'That is already the category in effect on 2027-03-01.' });
    db.reset();
    facts({ placement: { clinId: 'c1', slinId: null } });
    expect(await correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: L })).toEqual({ ok: false, code: 'validation', error: 'Nothing to correct — the category is unchanged.' });
    expect(writes()).toEqual([]);
  });

  it('DR-2: re-prices hours without a reason → refused; remove of another code\'s change → not_found', async () => {
    facts({ placement: { clinId: 'c1', slinId: null }, hours: '8.00' });
    expect(await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M })).toEqual({ ok: false, code: 'validation', error: 'A reason is required because this change re-prices recorded hours.' });
    db.reset();
    facts({});
    expect(await removeChargeCodeCategoryChange({ chargeCodeId: K, changeId: X1, reason: 'r' })).toEqual({ ok: false, code: 'not_found', error: 'That category period no longer exists. Refresh and try again.' });
    expect(writes()).toEqual([]);
    expect(h.logged).toEqual([]);
  });

  it('D3 first category: a new code (starting null, no entries) gets its starting category without a reason; logged', async () => {
    facts({ code: { clinId: 'c1', slinId: null, laborCategoryId: null }, placement: { clinId: 'c1', slinId: null }, hours: '0.00' });
    db.onReturning('update', chargeCodes, [{ id: K }]);
    expect((await correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: L })).ok).toBe(true);
    expect(db.updates[0]).toMatchObject({ table: chargeCodes, set: { laborCategoryId: L } });
    expect(h.logged).toEqual([{
      actorId: 'adm', entity: 'charge_code_labor_category', entityId: K, action: 'category_corrected',
      oldValue: { target: 'starting', laborCategoryId: null },
      newValue: { target: 'starting', effectiveDate: null, laborCategoryId: L, reason: null, period: { from: null, toExclusive: null }, repricedHours: '0.00' },
    }]);
  });

  it('add and remove write and log as specified', async () => {
    facts({ placement: { clinId: 'c1', slinId: null }, hours: '8.00' });
    db.onReturning('insert', chargeCodeLaborCategories, [{ id: X1 }]);
    expect((await addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'rebid' })).ok).toBe(true);
    expect(db.inserts.find((i) => i.table === chargeCodeLaborCategories)!.values).toEqual({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, createdBy: 'adm' });
    expect(h.logged).toEqual([expect.objectContaining({
      action: 'category_change_added', oldValue: { target: 'starting', laborCategoryId: L },
      newValue: { target: X1, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'rebid', period: { from: '2027-03-01', toExclusive: null }, repricedHours: '8.00' },
    })]);
    db.reset(); h.logged = [];
    facts({ changes: [{ id: X1, effectiveDate: d('2027-03-01'), laborCategoryId: M }], hours: '8.00' });
    db.onReturning('delete', chargeCodeLaborCategories, [{ id: X1 }]);
    expect((await removeChargeCodeCategoryChange({ chargeCodeId: K, changeId: X1, reason: 'wrong' })).ok).toBe(true);
    expect(h.logged).toEqual([expect.objectContaining({
      action: 'category_change_removed', oldValue: { target: X1, laborCategoryId: M },
      newValue: { target: X1, effectiveDate: '2027-03-01', laborCategoryId: L, reason: 'wrong', period: { from: '2027-03-01', toExclusive: null }, repricedHours: '8.00' },
    })]);
  });

  it('preview: period + hours; DR-Q2 and not_found rules; no reason needed', async () => {
    db.onSelect(chargeCodes, [{ clinId: 'c1', slinId: null, laborCategoryId: L }]);
    db.onSelect(chargeCodeLaborCategories, []);
    db.onSelect(laborCategories, [{ clinId: 'c1', slinId: null }]);
    db.onSelect(timesheetEntries, [{ hours: '8.00' }]);
    expect(await previewChargeCodeCategoryImpact({ kind: 'add', chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M }))
      .toEqual({ ok: true, data: { hours: '8.00', from: '2027-03-01', toExclusive: null, reasonRequired: true } });
    db.reset();
    db.onSelect(chargeCodes, [{ clinId: 'c1', slinId: null, laborCategoryId: L }]);
    db.onSelect(chargeCodeLaborCategories, []);
    db.onSelect(laborCategories, [{ clinId: 'c9', slinId: null }]);
    expect(await previewChargeCodeCategoryImpact({ kind: 'add', chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M })).toMatchObject({ ok: false, error: /different CLIN or SLIN/ });
  });
});

describe('atomicity, no silent edit, static wiring, export', () => {
  it('a failing log write fails the action (inside the transaction; real rollback on Postgres)', async () => {
    h.logThrows = true;
    facts({ code: { clinId: 'c1', slinId: null, laborCategoryId: null }, placement: { clinId: 'c1', slinId: null }, hours: '0.00' });
    db.onReturning('update', chargeCodes, [{ id: K }]);
    await expect(correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: L })).rejects.toThrow('log write failed');
  });

  it('D3 no silent edit: updateChargeCode ignores a laborCategoryId key', async () => {
    db.onSelect(chargeCodes, [{ id: K, clinId: 'c1', slinId: null, laborCategoryId: L }]);
    db.onReturning('update', chargeCodes, [{ id: K }]);
    expect((await updateChargeCode(K, { name: 'N', laborCategoryId: M } as never)).ok).toBe(true);
    expect(db.updates[0].set).not.toHaveProperty('laborCategoryId');
  });

  it('static: mutations log through logAdminChange inside the transaction; the charge code row is locked FOR NO KEY UPDATE; guard first', () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/server/actions/charge-code-categories.ts'), 'utf8'));
    for (const fn of ['addChargeCodeCategoryChange', 'correctChargeCodeCategory', 'removeChargeCodeCategoryChange']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const tx = body.slice(body.indexOf('db.transaction(async (tx) => {'), body.indexOf('return view(tx'));
      expect(tx, fn).toMatch(/await logAdminChange\(tx, \{/);
      expect(tx, fn).toMatch(/lockAndReadCategorySchedule\(tx, v\.chargeCodeId\)/);
      expect(body.indexOf('await requireAdminFresh()'), fn).toBeLessThan(body.indexOf('await getDbForWrite()'));
    }
    const internal = readFileSync(path.join(ROOT, 'src/server/internal/labor-rates.ts'), 'utf8');
    const lock = internal.slice(internal.indexOf('export async function lockAndReadCategorySchedule'));
    expect(lock.slice(0, lock.indexOf('if (!row)'))).toMatch(/\.for\('no key update'\)/);
  });

  it('static: updateChargeCode no longer takes laborCategoryId; a move is refused while the code has categories (DR-Q2)', () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/server/actions/charge-codes.ts'), 'utf8'));
    const fn = src.slice(src.indexOf('export async function updateChargeCode'), src.indexOf('export async function deactivateChargeCode'));
    expect(fn).not.toMatch(/laborCategoryId\?:/);
    expect(fn).not.toMatch(/updateData\.laborCategoryId/);
    expect(fn).toMatch(/if \(current\.laborCategoryId \|\| dated\) \{/);
  });

  it('export: charge_code_labor_categories described; charge_codes.labor_category_id reworded', () => {
    const t = EXPORT_TABLES.find((x) => x.file === 'charge_code_labor_categories')!;
    expect(t.columns.map((c) => c.header)).toEqual(['id', 'charge_code_id', 'effective_date', 'labor_category_id', 'created_by', 'created_at', 'updated_at']);
    expect(EXPORT_TABLES.find((x) => x.file === 'charge_codes')!.columns.find((c) => c.header === 'labor_category_id')!.description)
      .toBe('Starting labor category — applies to days before the first change in charge_code_labor_categories.csv (labor_categories.csv id), if any.');
  });

  it('the 0016 migration is only the table, its FKs (labor category NO ACTION) and the unique index', () => {
    const dir = path.join(ROOT, 'drizzle');
    const sql = readFileSync(path.join(dir, readdirSync(dir).find((f) => /^0016_.*\.sql$/.test(f))!), 'utf8');
    expect(sql.match(/^(CREATE TABLE|ALTER TABLE|CREATE UNIQUE INDEX|CREATE INDEX|UPDATE|INSERT|DELETE)/gm)).toEqual(['CREATE TABLE', 'ALTER TABLE', 'ALTER TABLE', 'ALTER TABLE', 'CREATE UNIQUE INDEX']);
    expect(sql).toMatch(/"labor_category_id"\) REFERENCES "public"\."labor_categories"\("id"\) ON DELETE no action/);
    expect(sql).toContain('CREATE UNIQUE INDEX "cc_lcat_effective_unique_idx"');
  });
});
