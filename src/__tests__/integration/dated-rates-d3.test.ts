import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-dated-rates.md D3 / §9 — Postgres rows: D3 pricing → correction → removal → starting to none, D3 first
 * category, D3 bad category id, D3 SQL = TS, D3 DR-Q2, D3 no silent edit, D3 concurrency / atomicity / security /
 * validation, Duplicate mapping (cc_lcat_effective_unique_idx). Per-call write clients; session mock stubs the guards.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000d3', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
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

import { addChargeCodeCategoryChange, correctChargeCodeCategory, previewChargeCodeCategoryImpact, removeChargeCodeCategoryChange } from '@/server/actions/charge-code-categories';
import { updateChargeCode } from '@/server/actions/charge-codes';
import { getDetailedCostReportData } from '@/server/internal/reports';
import { chargeCodeLaborCategoryOnSql } from '@/server/internal/labor-rates';
import { chargeCodeCategoryOn } from '@/lib/labor-rates';
import { duplicateEntityMessage } from '@/lib/db-errors';

const d = (s: string) => s as CalendarDate;
const RANGE = [d('2027-01-01'), d('2027-06-30')] as const;
const money = (x: number | string) => Number(x).toFixed(2);

describe('charge codes: dated labor category (D3)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let clinId: string;
  let otherClinId: string;
  let L: string;
  let M: string;
  let K: string;
  const db = () => getTestDb();
  const lcat = async (clin: string, code: string, rate: string, slinId: string | null = null) =>
    (await db().insert(schema.laborCategories).values({ clinId: clin, slinId, lcatCode: code, title: code, hourlyRate: rate }).returning())[0].id;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    emp = await createTestUser({ role: 'employee', fullName: 'Ed Employee' });
    const contract = await createTestContract();
    clinId = (await createTestClin(contract.id)).id;
    otherClinId = (await createTestClin(contract.id)).id;
    L = await lcat(clinId, 'L', '100.00');
    M = await lcat(clinId, 'M', '90.00');
    K = (await createTestChargeCode(clinId, { laborCategoryId: L })).id;
    for (const entryDate of ['2027-01-15', '2027-03-15']) {
      await db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: K, clinId, entryDate, hours: '8.00', revisionNumber: 1, createdBy: emp.id });
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

  const costs = async () => (await getDetailedCostReportData(...RANGE)).sort((a, b) => a.entryDate.localeCompare(b.entryDate)).map((r) => money(r.totalCost));
  const changeOn = async (date: string) => (await db().select().from(schema.chargeCodeLaborCategories).where(eq(schema.chargeCodeLaborCategories.effectiveDate, date)))[0].id;
  const logRows = () => db().select().from(schema.adminChangeLog).where(eq(schema.adminChangeLog.entity, 'charge_code_labor_category'));

  it('D3 pricing → correction → removal → starting to none', async () => {
    expect(await costs()).toEqual(['800.00', '800.00']);
    await expectOk(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'rebid' }));
    expect(await costs()).toEqual(['800.00', '720.00']);
    await expectOk(correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: M, reason: 'was always M' }));
    expect(await costs()).toEqual(['720.00', '720.00']);
    await expectOk(removeChargeCodeCategoryChange({ chargeCodeId: K, changeId: await changeOn('2027-03-01'), reason: 'redundant' }));
    expect(await costs()).toEqual(['720.00', '720.00']); // starting is now M
    // Starting to none: E has L by assignment → K's entries fall through to E's category.
    await db().insert(schema.userLaborCategories).values({ userId: emp.id, laborCategoryId: L, effectiveDate: '2026-01-01' });
    await expectOk(correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: null, reason: 'code no longer bills a category' }));
    expect(await costs()).toEqual(['800.00', '800.00']);
    expect((await logRows()).map((r) => r.action).sort()).toEqual(['category_change_added', 'category_change_removed', 'category_corrected', 'category_corrected']);
  });

  it('D3 impact: preview add / correct starting / remove give the exact hours and period; the log records them', async () => {
    // A superseded revision on 2027-01-15 (rev 2 = the same 8.00 h): only the latest revision counts.
    await db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: K, clinId, entryDate: '2027-01-15', hours: '8.00', revisionNumber: 2, createdBy: emp.id, changeReasonCode: 'CORRECTION', comment: 'x' });
    expect(await expectOk(previewChargeCodeCategoryImpact({ kind: 'add', chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M })))
      .toEqual({ hours: '8.00', from: '2027-03-01', toExclusive: null, reasonRequired: true });
    await expectOk(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'r' }));
    expect(await expectOk(previewChargeCodeCategoryImpact({ kind: 'correct', chargeCodeId: K, target: 'starting', laborCategoryId: M })))
      .toEqual({ hours: '8.00', from: null, toExclusive: '2027-03-01', reasonRequired: true });
    const id = await changeOn('2027-03-01');
    expect(await expectOk(previewChargeCodeCategoryImpact({ kind: 'remove', chargeCodeId: K, changeId: id })))
      .toEqual({ hours: '8.00', from: '2027-03-01', toExclusive: null, reasonRequired: true });
    await expectOk(correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: M, reason: 'r' }));
    const logged = (await logRows()).map((r) => [r.action, (r.newValue as { repricedHours: string }).repricedHours]).sort();
    expect(logged).toEqual([['category_change_added', '8.00'], ['category_corrected', '8.00']]);
  });

  it('D3 first category: a new code with no entries gets its starting category without a reason', async () => {
    const fresh = (await createTestChargeCode(clinId)).id;
    await expectOk(correctChargeCodeCategory({ chargeCodeId: fresh, target: 'starting', laborCategoryId: L }));
    const [row] = await db().select().from(schema.chargeCodes).where(eq(schema.chargeCodes.id, fresh));
    expect(row.laborCategoryId).toBe(L);
    expect((await logRows())[0].newValue).toMatchObject({ reason: null, repricedHours: '0.00' });
  });

  it('D3 bad category id: not-a-uuid / unknown uuid / null on a dated change — nothing written', async () => {
    await expectFailure(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: 'not-a-uuid', reason: 'r' }), 'validation', /^Labor category is not a valid identifier\.$/);
    await expectFailure(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: '99999999-9999-4999-8999-999999999999', reason: 'r' }), 'not_found', /^Labor category not found\.$/);
    await expectFailure(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: null, reason: 'r' }), 'validation', /^A dated change must name a labor category\.$/);
    expect(await db().select().from(schema.chargeCodeLaborCategories)).toEqual([]);
  });

  it('D3 SQL = TS: chargeCodeLaborCategoryOnSql agrees with chargeCodeCategoryOn on the D3 dates', async () => {
    await expectOk(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'r' }));
    await expectOk(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-06-01', laborCategoryId: L, reason: 'r' })); // two changes: order matters
    const schedule = { starting: L, changes: (await db().select().from(schema.chargeCodeLaborCategories)).map((c) => ({ id: c.id, effectiveDate: c.effectiveDate as CalendarDate, laborCategoryId: c.laborCategoryId })) };
    for (const day of ['2026-12-31', '2027-01-15', '2027-02-28', '2027-03-01', '2027-03-15', '2027-05-31', '2027-06-01', '2030-01-01']) {
      const [row] = await db().select({ id: chargeCodeLaborCategoryOnSql({ chargeCodeId: sql`${schema.chargeCodes.id}`, onDate: sql`${day}::date` }) })
        .from(schema.chargeCodes).where(eq(schema.chargeCodes.id, K));
      expect(row.id, day).toBe(chargeCodeCategoryOn(schedule, d(day)).laborCategoryId);
    }
  });

  it('D3 DR-Q2: another CLIN or a SLIN mismatch is refused; a code with categories can\'t move to another CLIN', async () => {
    const foreign = await lcat(otherClinId, 'F', '50.00');
    await expectFailure(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: foreign, reason: 'r' }), 'validation', /different CLIN or SLIN/);
    const [s1] = await db().insert(schema.slins).values({ clinId, slinNumber: 'A1' }).returning();
    const [s2] = await db().insert(schema.slins).values({ clinId, slinNumber: 'A2' }).returning();
    const onS2 = await lcat(clinId, 'S2', '70.00', s2.id);
    const slinCode = (await createTestChargeCode(clinId, { slinId: s1.id })).id;
    await expectFailure(correctChargeCodeCategory({ chargeCodeId: slinCode, target: 'starting', laborCategoryId: onS2 }), 'validation', /different CLIN or SLIN/);
    const movable = (await createTestChargeCode(clinId, { laborCategoryId: L })).id; // unused, but has a category
    await expectFailure(updateChargeCode(movable, { clinId: otherClinId }), 'validation', /^Remove this charge code's labor categories before moving it to another CLIN or SLIN\.$/);
    expect(await db().select().from(schema.chargeCodeLaborCategories)).toEqual([]);
    expect((await db().select().from(schema.chargeCodes).where(eq(schema.chargeCodes.id, movable)))[0].clinId).toBe(clinId);
  });

  it('D3 no silent edit: updateChargeCode with a laborCategoryId leaves the category unchanged', async () => {
    await expectOk(updateChargeCode(K, { name: 'Renamed', laborCategoryId: M } as never));
    expect((await db().select().from(schema.chargeCodes).where(eq(schema.chargeCodes.id, K)))[0]).toMatchObject({ name: 'Renamed', laborCategoryId: L });
  });

  it('D3 validation: duplicate date, already in effect, nothing to correct, remove twice — exact messages', async () => {
    await expectOk(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'r' }));
    await expectFailure(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: L, reason: 'r' }), 'conflict', /^There is already a category change on 2027-03-01 for this charge code\. Correct that one instead\.$/);
    await expectFailure(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-04-01', laborCategoryId: M, reason: 'r' }), 'validation', /^That is already the category in effect on 2027-04-01\.$/);
    await expectFailure(correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: L, reason: 'r' }), 'validation', /^Nothing to correct — the category is unchanged\.$/);
    await expectFailure(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-02-01', laborCategoryId: M }), 'validation', /A reason is required/);
    const id = await changeOn('2027-03-01');
    await expectOk(removeChargeCodeCategoryChange({ chargeCodeId: K, changeId: id, reason: 'r' }));
    await expectFailure(removeChargeCodeCategoryChange({ chargeCodeId: K, changeId: id, reason: 'r' }), 'not_found', /^That category period no longer exists\. Refresh and try again\.$/);
  });

  it('D3 concurrency (lock, deterministic): waits on the charge code row, then the date-specific conflict', async () => {
    const r = postgres(URL, { max: 1 });
    writers.open.push(r);
    let pending!: Promise<Awaited<ReturnType<typeof addChargeCodeCategoryChange>>>;
    let settled = false;
    await r.begin(async (tx) => {
      await tx`SELECT id FROM charge_codes WHERE id = ${K} FOR NO KEY UPDATE`;
      await tx`INSERT INTO charge_code_labor_categories (charge_code_id, effective_date, labor_category_id) VALUES (${K}, '2027-03-01', ${M})`;
      pending = addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'r' });
      pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((res) => setTimeout(res, 200));
      expect(settled).toBe(false);
    });
    expect(await pending).toEqual({ ok: false, code: 'conflict', error: 'There is already a category change on 2027-03-01 for this charge code. Correct that one instead.' });
  });

  it('Duplicate mapping (cc_lcat_effective_unique_idx): a real duplicate maps to the static message', async () => {
    await db().insert(schema.chargeCodeLaborCategories).values({ chargeCodeId: K, effectiveDate: '2027-05-01', laborCategoryId: M });
    const err = await db().insert(schema.chargeCodeLaborCategories).values({ chargeCodeId: K, effectiveDate: '2027-05-01', laborCategoryId: L }).catch((e) => e);
    expect(duplicateEntityMessage(err)).toBe('There is already a category change on that date for this charge code. Correct that one instead.');
  });

  it('D3 atomicity: a failing log write leaves nothing — no change row, starting category unchanged, no log row', async () => {
    logFail.on = true;
    await expect(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'r' })).rejects.toThrow('log write failed');
    await expect(correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: M, reason: 'r' })).rejects.toThrow('log write failed');
    expect(await db().select().from(schema.chargeCodeLaborCategories)).toEqual([]);
    expect((await db().select().from(schema.chargeCodes).where(eq(schema.chargeCodes.id, K)))[0].laborCategoryId).toBe(L);
    expect(await logRows()).toEqual([]);
  });

  it('D3 security: signed out → unauthenticated; non-admin → forbidden; nothing written', async () => {
    session.user = null;
    await expectFailure(addChargeCodeCategoryChange({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'r' }), 'unauthenticated');
    session.user = { id: emp.id, role: 'employee', email: emp.email, fullName: emp.fullName };
    await expectFailure(correctChargeCodeCategory({ chargeCodeId: K, target: 'starting', laborCategoryId: M, reason: 'r' }), 'forbidden');
    expect(await db().select().from(schema.chargeCodeLaborCategories)).toEqual([]);
  });
});
