import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-dated-rates.md D1 / §9 — Postgres rows on Fixture F1: SQL = TS, Pricing, Correction, Removal, Grouping,
 * Unpriced, Impact, DR-2, Validation, Concurrency (lock), Duplicate mapping, Atomicity (real rollback), Security,
 * No silent edit. Writes get their OWN connection per call (trap T5); the session mock stubs requireAdminFresh /
 * requireAdmin (trap T11).
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const writers = vi.hoisted(() => ({ open: [] as Array<{ end: (o?: { timeout?: number }) => Promise<void> }> }));
vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => {
    const c = postgres(process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test', { max: 1 });
    writers.open.push(c);
    return drizzle(c, { schema: await import('@/db/schema') });
  },
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000d1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
type FakeUser = { id: string; role: 'admin' | 'supervisor' | 'employee'; email: string; fullName: string };
const session = vi.hoisted(() => ({ user: null as null | FakeUser }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => {
    if (!session.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return session.user;
  };
  const admin = () => { const u = current(); if (u.role !== 'admin') throw new actual.AuthorizationError('forbidden', 'Forbidden'); return u; };
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), requireAdmin: async () => admin(), requireAdminFresh: async () => admin(), getEmployeeScope: async () => 'all' };
});
const logFail = vi.hoisted(() => ({ on: false }));
vi.mock('@/server/internal/admin-change-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/admin-change-log')>();
  return { ...actual, logAdminChange: async (...args: Parameters<typeof actual.logAdminChange>) => { if (logFail.on) throw new Error('log write failed'); return actual.logAdminChange(...args); } };
});

import { addLaborCategoryRateChange, correctLaborCategoryRate, removeLaborCategoryRateChange, previewRateChangeImpact } from '@/server/actions/labor-category-rates';
import { updateLaborCategory } from '@/server/actions/labor-categories';
import { getDetailedCostReportData } from '@/server/internal/reports';
import { getPeriodCostReport } from '@/server/actions/dashboard';
import { hourlyRateOnSql } from '@/server/internal/labor-rates';
import { rateOn } from '@/lib/labor-rates';
import { duplicateEntityMessage } from '@/lib/db-errors';

const d = (s: string) => s as CalendarDate;
const RANGE = [d('2026-12-01'), d('2027-06-30')] as const;
const money = (x: number | string) => Number(x).toFixed(2);

describe('dated labor-category rates (D1, Fixture F1)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let clinId: string;
  let L: string;
  let codeId: string;
  const db = () => getTestDb();

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    emp = await createTestUser({ role: 'employee', fullName: 'Ed Employee' });
    clinId = (await createTestClin((await createTestContract()).id)).id;
    [{ id: L }] = await db().insert(schema.laborCategories).values({ clinId, lcatCode: 'L', title: 'Engineer', hourlyRate: '100.00', ceilingRate: '150.00' }).returning();
    await db().insert(schema.userLaborCategories).values({ userId: emp.id, laborCategoryId: L, effectiveDate: '2026-01-01' });
    codeId = (await createTestChargeCode(clinId)).id; // no category of its own
    for (const [entryDate, hours] of [['2026-12-31', '8.00'], ['2027-01-01', '8.00'], ['2027-06-30', '4.00']]) {
      await db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: codeId, clinId, entryDate, hours, revisionNumber: 1, createdBy: emp.id });
    }
    session.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
    logFail.on = false;
  });
  afterEach(async () => {
    session.user = null;
    while (writers.open.length) await writers.open.pop()!.end({ timeout: 1 }).catch(() => {});
    await cleanupTestData();
  });
  afterAll(async () => { while (writers.open.length) await writers.open.pop()!.end({ timeout: 1 }).catch(() => {}); });

  const costs = async () => (await getDetailedCostReportData(...RANGE)).sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const add = (effectiveDate: string, hourlyRate: string, reason?: string) =>
    addLaborCategoryRateChange({ laborCategoryId: L, effectiveDate, hourlyRate, ceilingRate: null, ...(reason !== undefined ? { reason } : {}) });
  const changeId = async (date: string) => (await db().select().from(schema.laborCategoryRates).where(and(eq(schema.laborCategoryRates.laborCategoryId, L), eq(schema.laborCategoryRates.effectiveDate, date))))[0].id;
  const logRows = () => db().select().from(schema.adminChangeLog).where(eq(schema.adminChangeLog.entity, 'labor_category_rate'));

  it('SQL = TS: hourlyRateOnSql and rateOn agree on every date', async () => {
    await expectOk(add('2027-01-01', '110.00', 'r'));
    const view = await expectOk(add('2027-04-01', '120.00', 'r'));
    for (const day of ['2020-01-01', '2026-12-31', '2027-01-01', '2027-03-31', '2027-04-01', '2030-01-01']) {
      const [row] = await db().select({ rate: hourlyRateOnSql({ laborCategoryId: sql`${schema.laborCategories.id}`, onDate: sql`${day}::date` }) })
        .from(schema.laborCategories).where(eq(schema.laborCategories.id, L));
      expect(money(row.rate), day).toBe(money(rateOn(view, d(day)).hourlyRate));
    }
  });

  it('Pricing → Correction → Removal: each step re-prices exactly its period; the log records each change', async () => {
    expect((await costs()).map((r) => money(r.totalCost))).toEqual(['800.00', '800.00', '400.00']);
    expect(money((await getPeriodCostReport(...RANGE)).reduce((s, r) => s + r.totalCost, 0))).toBe('2000.00');

    await expectOk(add('2027-01-01', '110.00', 'option year'));
    const afterFirst = await costs();
    expect(afterFirst.map((r) => money(r.totalCost))).toEqual(['800.00', '880.00', '440.00']);
    expect(afterFirst.map((r) => money(r.hourlyRate))).toEqual(['100.00', '110.00', '110.00']);

    await expectOk(add('2027-04-01', '120.00', 'escalation'));
    expect((await costs()).map((r) => money(r.totalCost))).toEqual(['800.00', '880.00', '480.00']);

    await expectOk(correctLaborCategoryRate({ laborCategoryId: L, target: 'starting', hourlyRate: '105.00', ceilingRate: '150.00', reason: 'typo' }));
    expect((await costs()).map((r) => money(r.totalCost))).toEqual(['840.00', '880.00', '480.00']);
    const corrected = (await logRows()).filter((r) => r.action === 'rate_corrected');
    expect(corrected).toEqual([expect.objectContaining({
      actorId: admin.id, entityId: L,
      oldValue: { target: 'starting', hourlyRate: '100.00', ceilingRate: '150.00' },
      newValue: { target: 'starting', hourlyRate: '105.00', ceilingRate: '150.00', reason: 'typo', period: { from: null, toExclusive: '2027-01-01' }, repricedHours: '8.00' },
    })]);

    await expectOk(correctLaborCategoryRate({ laborCategoryId: L, target: await changeId('2027-01-01'), hourlyRate: '112.00', ceilingRate: null, reason: 'mod 3' }));
    expect((await costs()).map((r) => money(r.totalCost))).toEqual(['840.00', '896.00', '480.00']);

    await expectOk(removeLaborCategoryRateChange({ laborCategoryId: L, changeId: await changeId('2027-04-01'), reason: 'wrong date' }));
    expect((await costs()).map((r) => money(r.totalCost))).toEqual(['840.00', '896.00', '448.00']);
    expect((await logRows()).find((r) => r.action === 'rate_change_removed')).toMatchObject({
      oldValue: { effectiveDate: '2027-04-01', hourlyRate: '120.00', ceilingRate: null }, newValue: { reason: 'wrong date', repricedHours: '4.00' },
    });
    expect((await logRows()).map((r) => r.action).sort()).toEqual(['rate_change_added', 'rate_change_added', 'rate_change_removed', 'rate_corrected', 'rate_corrected']);
  });

  it('Grouping: after the first add the period report shows two rows for E/L — rate 100 (8.00 h) and rate 110 (12.00 h)', async () => {
    await expectOk(add('2027-01-01', '110.00', 'r'));
    const rows = (await getPeriodCostReport(...RANGE)).filter((r) => r.lcatCode === 'L').map((r) => [money(r.hourlyRate), money(r.totalHours)]).sort();
    expect(rows).toEqual([['100.00', '8.00'], ['110.00', '12.00']]);
  });

  it('Unpriced: an entry with no resolvable category stays unpriced, no cost, in the unpriced count', async () => {
    await expectOk(add('2027-01-01', '110.00', 'r'));
    const other = await createTestUser({ role: 'employee' });
    await db().insert(schema.timesheetEntries).values({ userId: other.id, chargeCodeId: codeId, clinId, entryDate: '2027-02-01', hours: '5.00', revisionNumber: 1, createdBy: other.id });
    const row = (await costs()).find((r) => r.employeeEmail === other.email)!;
    expect(row).toMatchObject({ costBasis: 'unpriced', totalCost: 0, unpricedHours: 5 });
    const period = await getPeriodCostReport(...RANGE);
    expect(period.find((r) => r.lcatTitle === 'Unpriced')).toMatchObject({ totalCost: 0, unpricedHours: 5, totalHours: 5 });
    expect(money(period.reduce((s, r) => s + r.totalCost, 0))).toBe('2120.00'); // the priced total is unchanged by it
  });

  it('Impact: preview add / correct starting / remove give the exact hours and period', async () => {
    // A superseded revision on 2027-01-01 (rev 2 = the same 8.00 h): only the latest revision counts.
    await db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: codeId, clinId, entryDate: '2027-01-01', hours: '8.00', revisionNumber: 2, createdBy: emp.id, changeReasonCode: 'CORRECTION', comment: 'x' });
    expect(await expectOk(previewRateChangeImpact({ kind: 'add', laborCategoryId: L, effectiveDate: '2027-01-01', hourlyRate: '110', ceilingRate: null })))
      .toEqual({ hours: '12.00', from: '2027-01-01', toExclusive: null, reasonRequired: true });
    await expectOk(add('2027-01-01', '110.00', 'r'));
    expect(await expectOk(previewRateChangeImpact({ kind: 'correct', laborCategoryId: L, target: 'starting', hourlyRate: '105', ceilingRate: null })))
      .toMatchObject({ hours: '8.00', from: null, toExclusive: '2027-01-01' });
    await expectOk(add('2027-04-01', '120.00', 'r'));
    expect(await expectOk(previewRateChangeImpact({ kind: 'remove', laborCategoryId: L, changeId: await changeId('2027-04-01') })))
      .toMatchObject({ hours: '4.00', from: '2027-04-01', toExclusive: null });
  });

  it('DR-2: a reason is required exactly when recorded hours are re-priced; a zero-impact add succeeds without one', async () => {
    await expectFailure(add('2027-01-01', '110.00'), 'validation', /A reason is required because this change re-prices recorded hours\./);
    expect(await db().select().from(schema.laborCategoryRates)).toEqual([]);
    await expectOk(add('2027-01-01', '110.00', 'r'));
    await expectFailure(correctLaborCategoryRate({ laborCategoryId: L, target: 'starting', hourlyRate: '105', ceilingRate: '150' }), 'validation', /A reason is required/);
    for (const [date, reason] of [['2028-01-01', undefined], ['2028-02-01', ''], ['2028-03-01', '   ']] as const) {
      await expectOk(add(date, date === '2028-01-01' ? '130' : date === '2028-02-01' ? '131' : '132', reason));
    }
    const zeroImpact = (await logRows()).filter((r) => (r.newValue as { effectiveDate?: string }).effectiveDate?.startsWith('2028'));
    expect(zeroImpact).toHaveLength(3);
    for (const r of zeroImpact) expect(r.newValue).toMatchObject({ reason: null, repricedHours: '0.00' });
  });

  it('Validation: exact messages / codes, nothing written, no log row', async () => {
    await expectOk(add('2027-01-01', '110.00', 'r'));
    const before = (await db().select().from(schema.laborCategoryRates)).length;
    await expectFailure(add('2027-01-01', '115', 'r'), 'conflict', /^There is already a rate change on 2027-01-01 for this labor category\. Correct that one instead\.$/);
    await expectFailure(add('2027-02-01', '110', 'r'), 'validation', /^That is already the rate in effect on 2027-02-01\.$/);
    await expectFailure(add('2027-02-30', '115', 'r'), 'validation', /^Effective date is not a valid date\.$/);
    await expectFailure(add('2027-02-01', '-1', 'r'), 'validation', /^Hourly rate cannot be negative\.$/);
    await expectFailure(add('2027-02-01', 'abc', 'r'), 'validation', /^Hourly rate must be a valid number\.$/);
    await expectFailure(addLaborCategoryRateChange({ laborCategoryId: 'not-a-uuid', effectiveDate: '2027-02-01', hourlyRate: '1', ceilingRate: null }), 'validation', /^Labor category is not a valid identifier\.$/);
    await expectFailure(add('2027-02-01', '115', 'x'.repeat(501)), 'validation', /Reason must not exceed 500 characters/);
    await expectFailure(correctLaborCategoryRate({ laborCategoryId: L, target: await changeId('2027-01-01'), hourlyRate: '110', ceilingRate: null }), 'validation', /^Nothing to correct — the values are unchanged\.$/);
    const [{ id: other }] = await db().insert(schema.laborCategories).values({ clinId, lcatCode: 'O', title: 'Other', hourlyRate: '50.00' }).returning();
    const [{ id: otherChange }] = await db().insert(schema.laborCategoryRates).values({ laborCategoryId: other, effectiveDate: '2027-01-01', hourlyRate: '60.00' }).returning();
    await expectFailure(removeLaborCategoryRateChange({ laborCategoryId: L, changeId: otherChange, reason: 'r' }), 'not_found', /^That rate period no longer exists\. Refresh and try again\.$/);
    const own = await changeId('2027-01-01');
    await expectOk(removeLaborCategoryRateChange({ laborCategoryId: L, changeId: own, reason: 'r' }));
    await expectFailure(removeLaborCategoryRateChange({ laborCategoryId: L, changeId: own, reason: 'r' }), 'not_found', /no longer exists/);
    expect((await db().select().from(schema.laborCategoryRates).where(eq(schema.laborCategoryRates.laborCategoryId, L))).length).toBe(before - 1);
    expect((await logRows()).map((r) => r.action).sort()).toEqual(['rate_change_added', 'rate_change_removed']);
  });

  it('Concurrency (lock, deterministic): the action waits on FOR NO KEY UPDATE, then the pre-check returns the DATE-SPECIFIC conflict', async () => {
    const r = postgres(URL, { max: 1 });
    writers.open.push(r);
    let pending!: Promise<Awaited<ReturnType<typeof addLaborCategoryRateChange>>>;
    let settled = false;
    await r.begin(async (tx) => {
      await tx`SELECT id FROM labor_categories WHERE id = ${L} FOR NO KEY UPDATE`;
      await tx`INSERT INTO labor_category_rates (labor_category_id, effective_date, hourly_rate) VALUES (${L}, '2027-01-01', '115.00')`;
      pending = add('2027-01-01', '110.00', 'r');
      pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((res) => setTimeout(res, 200));
      expect(settled).toBe(false); // still waiting on the category lock
    });
    expect(await pending).toEqual({ ok: false, code: 'conflict', error: 'There is already a rate change on 2027-01-01 for this labor category. Correct that one instead.' });
  });

  it('Duplicate mapping: a real duplicate (labor_category_id, effective_date) maps to the static message', async () => {
    await db().insert(schema.laborCategoryRates).values({ laborCategoryId: L, effectiveDate: '2027-05-01', hourlyRate: '1.00' });
    const err = await db().insert(schema.laborCategoryRates).values({ laborCategoryId: L, effectiveDate: '2027-05-01', hourlyRate: '2.00' }).catch((e) => e);
    expect(duplicateEntityMessage(err)).toBe('There is already a rate change on that date for this labor category. Correct that one instead.');
  });

  it('Atomicity: when the log write fails, nothing is written — no change row, starting rate unchanged', async () => {
    logFail.on = true;
    await expect(add('2028-01-01', '130', 'r')).rejects.toThrow('log write failed');
    await expect(correctLaborCategoryRate({ laborCategoryId: L, target: 'starting', hourlyRate: '105', ceilingRate: '150', reason: 'typo' })).rejects.toThrow('log write failed');
    expect(await db().select().from(schema.laborCategoryRates)).toEqual([]);
    const [lc] = await db().select().from(schema.laborCategories).where(eq(schema.laborCategories.id, L));
    expect(lc.hourlyRate).toBe('100.00');
    expect(await logRows()).toEqual([]);
  });

  it('Security: signed out → unauthenticated; a non-admin → forbidden; nothing written', async () => {
    session.user = null;
    await expectFailure(add('2028-01-01', '130', 'r'), 'unauthenticated');
    await expectFailure(previewRateChangeImpact({ kind: 'add', laborCategoryId: L, effectiveDate: '2028-01-01', hourlyRate: '1', ceilingRate: null }), 'unauthenticated');
    session.user = { id: emp.id, role: 'employee', email: emp.email, fullName: emp.fullName };
    await expectFailure(correctLaborCategoryRate({ laborCategoryId: L, target: 'starting', hourlyRate: '1', ceilingRate: null, reason: 'r' }), 'forbidden');
    expect(await db().select().from(schema.laborCategoryRates)).toEqual([]);
  });

  it('No silent edit: updateLaborCategory with an hourlyRate key leaves the stored rate unchanged', async () => {
    await expectOk(updateLaborCategory(L, { title: 'Renamed', hourlyRate: '999.00' } as never));
    const [lc] = await db().select().from(schema.laborCategories).where(eq(schema.laborCategories.id, L));
    expect(lc).toMatchObject({ title: 'Renamed', hourlyRate: '100.00' });
  });
});
