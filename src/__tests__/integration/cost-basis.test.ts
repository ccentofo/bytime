import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { diffDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData, expectOk, expectFailure,
} from './helpers';

/**
 * feature-plan-certified-outputs.md C3 / §9 rows "Unpriced", "Cost basis", "Unpriced visibility", "Charge code",
 * "Change log", "Corrections (CO-D8)": the cost-basis SQL (src/server/internal/cost-basis.ts) against real Postgres,
 * through the real report/dashboard actions and the v1 costs route; charge-code CLIN immutability and its race with a
 * first save on separate connections.
 */

const writers = vi.hoisted(() => ({ perCall: false, open: [] as Array<{ end: (o?: { timeout?: number }) => Promise<void> }> }));
vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => {
    if (!writers.perCall) return getTestDb();
    const c = postgres(process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test', { max: 1 });
    writers.open.push(c);
    return drizzle(c, { schema });
  },
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000c3', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
type FakeUser = { id: string; role: 'admin' | 'supervisor' | 'employee'; email: string; fullName: string };
const session = vi.hoisted(() => ({ user: null as null | FakeUser, byCall: null as null | { getStore(): FakeUser | undefined } }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => {
    const u = session.byCall?.getStore() ?? session.user;
    if (!u) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return u;
  };
  const admin = () => { const u = current(); if (u.role !== 'admin') throw new actual.AuthorizationError('forbidden', 'Forbidden'); return u; };
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), requireAdmin: async () => admin(), requireAdminFresh: async () => admin(), requireApprover: async () => current(), requireApproverFresh: async () => current(), getEmployeeScope: async () => 'all' };
});

import { AsyncLocalStorage } from 'node:async_hooks';
import { getDetailedCostReport, getEmployeeSummaryReport } from '@/server/actions/reports';
import { getContractSummaries, getPeriodCostReport } from '@/server/actions/dashboard';
import { getUnpricedHoursReport, getOverlappingAssignmentsReport, endUserLaborCategoryAssignment } from '@/server/actions/labor-categories';
import { updateChargeCode, reactivateChargeCode, deactivateChargeCode } from '@/server/actions/charge-codes';
import { saveTimesheetBatch, getChargeCodesForUser } from '@/server/actions/timesheet';
import { GET as getV1Costs } from '@/app/api/v1/costs/route';

const als = new AsyncLocalStorage<FakeUser>();
session.byCall = als;
const as = (u: { id: string; role: string; email: string; fullName: string }): FakeUser => ({ id: u.id, role: u.role as FakeUser['role'], email: u.email, fullName: u.fullName });
const D1 = '2026-03-02' as CalendarDate;
const D2 = '2026-03-03' as CalendarDate;
const RANGE = ['2026-03-01' as CalendarDate, '2026-03-31' as CalendarDate] as const;

describe('cost basis (certified-outputs C3)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let contract: Awaited<ReturnType<typeof createTestContract>>;
  let clinA: Awaited<ReturnType<typeof createTestClin>>;
  let clinB: Awaited<ReturnType<typeof createTestClin>>;
  const db = () => getTestDb();
  const lcat = async (clinId: string, code: string, rate: string, o: Partial<typeof schema.laborCategories.$inferInsert> = {}) =>
    (await db().insert(schema.laborCategories).values({ clinId, lcatCode: code, title: code, hourlyRate: rate, ...o }).returning())[0];
  const assign = async (userId: string, laborCategoryId: string, effectiveDate: string, endDate: string | null = null) =>
    (await db().insert(schema.userLaborCategories).values({ userId, laborCategoryId, effectiveDate, endDate }).returning())[0];
  const entry = async (o: Partial<typeof schema.timesheetEntries.$inferInsert>) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, entryDate: D1, hours: '8', revisionNumber: 1, createdBy: emp.id, ...o });

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin' });
    emp = await createTestUser({ role: 'employee' });
    contract = await createTestContract();
    clinA = await createTestClin(contract.id);
    clinB = await createTestClin(contract.id);
    session.user = as(admin);
  });
  afterEach(async () => {
    session.user = null;
    writers.perCall = false;
    while (writers.open.length) await writers.open.pop()!.end({ timeout: 1 }).catch(() => {});
    await cleanupTestData();
  });
  afterAll(async () => { while (writers.open.length) await writers.open.pop()!.end({ timeout: 1 }).catch(() => {}); });

  it('a charge code with a labor category uses it (level 1), even with a CLIN assignment at another rate', async () => {
    const coded = await lcat(clinA.id, 'CODE', '200.00');
    const assigned = await lcat(clinA.id, 'ASG', '100.00');
    await assign(emp.id, assigned.id, '2026-01-01');
    const cc = await createTestChargeCode(clinA.id, { laborCategoryId: coded.id });
    await entry({ chargeCodeId: cc.id, clinId: clinA.id });
    const [row] = await getDetailedCostReport(...RANGE);
    expect(row).toMatchObject({ lcatCode: 'CODE', hourlyRate: 200, totalCost: 1600, costBasis: 'priced' });
  });

  it('a SLIN-matched assignment is used for a SLIN entry; a SLIN-level category on a DIFFERENT SLIN is never borrowed', async () => {
    const [s1] = await db().insert(schema.slins).values({ clinId: clinA.id, slinNumber: 'AA' }).returning();
    const [s2] = await db().insert(schema.slins).values({ clinId: clinA.id, slinNumber: 'AB' }).returning();
    const onS1 = await lcat(clinA.id, 'S1', '150.00', { slinId: s1.id });
    await assign(emp.id, onS1.id, '2026-01-01');
    await entry({ clinId: clinA.id, slinId: s1.id, entryDate: D1 });
    await entry({ clinId: clinA.id, slinId: s2.id, entryDate: D2 });
    const rows = await getDetailedCostReport(...RANGE);
    expect(rows.find((r) => r.entryDate === D1)).toMatchObject({ lcatCode: 'S1', totalCost: 1200, costBasis: 'priced' });
    expect(rows.find((r) => r.entryDate === D2)).toMatchObject({ costBasis: 'unpriced', unpricedReason: 'no-category', totalCost: 0, totalHours: 8 });
  });

  it('two different categories at the CLIN level on the same date → unpriced "conflict", listed with the fix and the overlap report', async () => {
    const a = await lcat(clinA.id, 'SE2', '100.00');
    const b = await lcat(clinA.id, 'SE3', '120.00');
    await assign(emp.id, a.id, '2026-01-01');
    await assign(emp.id, b.id, '2026-02-01');
    await entry({ clinId: clinA.id });
    expect((await getDetailedCostReport(...RANGE))[0]).toMatchObject({ costBasis: 'unpriced', unpricedReason: 'conflict', totalCost: 0 });
    const report = await getUnpricedHoursReport({});
    expect(report.rows).toEqual([expect.objectContaining({ reason: 'conflict', hours: 8, fix: expect.stringMatching(/has SE2 and SE3 on CLIN .* effective 2026-03-02 — end one\./) })]);
    expect((await getOverlappingAssignmentsReport()).map((o) => [o.a.lcatCode, o.b.lcatCode].sort())).toEqual([['SE2', 'SE3']]);
  });

  it('no applicable category → unpriced "no-category": hours counted, no cost, listed with how to fix, footer count everywhere', async () => {
    const cc = await createTestChargeCode(clinA.id);
    await entry({ chargeCodeId: cc.id, clinId: clinA.id });
    const [row] = await getDetailedCostReport(...RANGE);
    expect(row).toMatchObject({ costBasis: 'unpriced', unpricedReason: 'no-category', totalHours: 8, totalCost: 0, unpricedHours: 8 });
    expect((await getUnpricedHoursReport({})).rows[0].fix).toMatch(/^Set a labor category on charge code .*, or give .* a labor category on CLIN .* effective 2026-03-02\.$/);
    const summary = await getContractSummaries();
    const c = summary.find((s) => s.contractId === contract.id)!;
    expect(c).toMatchObject({ totalHours: 8, totalCost: 0, unpricedHours: 8 });
    expect(c.clinSummaries.find((x) => x.clinId === clinA.id)).toMatchObject({ unpricedHours: 8, totalCost: 0 });
    const period = await getPeriodCostReport(...RANGE);
    expect(period).toEqual([expect.objectContaining({ costBasis: 'unpriced', lcatTitle: 'Unpriced', totalHours: 8, totalCost: 0, unpricedHours: 8 })]);
  });

  it('an employee with labor categories on TWO CLINs: summary hours = true hours; one detailed row per entry', async () => {
    const onA = await lcat(clinA.id, 'A', '100.00');
    const onB = await lcat(clinB.id, 'B', '50.00');
    await assign(emp.id, onA.id, '2026-01-01');
    await assign(emp.id, onB.id, '2026-01-01');
    await entry({ clinId: clinA.id, entryDate: D1 });
    await entry({ clinId: clinB.id, entryDate: D2 });
    const detailed = await getDetailedCostReport(...RANGE);
    expect(detailed).toHaveLength(2);
    const summary = await getEmployeeSummaryReport(...RANGE);
    expect(summary.reduce((s, r) => s + r.totalHours, 0)).toBe(16);
    expect(summary.reduce((s, r) => s + (r.totalCost ?? 0), 0)).toBe(1200);
    const dash = (await getContractSummaries()).find((s) => s.contractId === contract.id)!;
    expect(dash).toMatchObject({ totalCost: 1200, unpricedHours: 0 });
  });

  it('F6: two employees with the SAME name are two summary rows (grouped by id, not name)', async () => {
    const twin = await createTestUser({ role: 'employee', fullName: emp.fullName });
    await entry({ clinId: clinA.id, entryDate: D1, hours: '8' });
    await entry({ clinId: clinA.id, entryDate: D1, hours: '5', userId: twin.id, createdBy: twin.id });
    const summary = (await getEmployeeSummaryReport(...RANGE)).filter((r) => r.employeeName === emp.fullName);
    expect(summary.map((r) => [r.employeeId, r.totalHours]).sort()).toEqual([[emp.id, 8], [twin.id, 5]].sort());
  });

  // ── T5 ───────────────────────────────────────────────────────────────────
  it('T5: two different categories on the entry\'s SLIN, same date → unpriced "conflict" at the SLIN level', async () => {
    const [s1] = await db().insert(schema.slins).values({ clinId: clinA.id, slinNumber: 'SA' }).returning();
    const a = await lcat(clinA.id, 'SA1', '100.00', { slinId: s1.id });
    const b = await lcat(clinA.id, 'SA2', '120.00', { slinId: s1.id });
    await assign(emp.id, a.id, '2026-01-01');
    await assign(emp.id, b.id, '2026-02-01');
    await entry({ clinId: clinA.id, slinId: s1.id });
    expect((await getDetailedCostReport(...RANGE))[0]).toMatchObject({ costBasis: 'unpriced', unpricedReason: 'conflict', totalCost: 0 });
    expect((await getUnpricedHoursReport({})).rows[0]).toMatchObject({ reason: 'conflict', level: 'slin' });
  });

  it('T5: SLIN beats CLIN — a CLIN-level category A and a SLIN-level category B on the entry\'s SLIN → B', async () => {
    const [s1] = await db().insert(schema.slins).values({ clinId: clinA.id, slinNumber: 'SB' }).returning();
    const a = await lcat(clinA.id, 'CLINA', '100.00');
    const b = await lcat(clinA.id, 'SLINB', '150.00', { slinId: s1.id });
    await assign(emp.id, a.id, '2026-01-01');
    await assign(emp.id, b.id, '2026-01-01');
    await entry({ clinId: clinA.id, slinId: s1.id });
    expect((await getDetailedCostReport(...RANGE))[0]).toMatchObject({ lcatCode: 'SLINB', hourlyRate: 150, totalCost: 1200, costBasis: 'priced' });
  });

  it('T5: dashboard SLIN summaries carry the exact priced cost and unpriced hours; the employee summary carries unpricedHours', async () => {
    const [s1] = await db().insert(schema.slins).values({ clinId: clinA.id, slinNumber: 'SC', fundedAmount: '10000' }).returning();
    const priced = await lcat(clinA.id, 'SC1', '90.00', { slinId: s1.id });
    await assign(emp.id, priced.id, '2026-01-01');
    await entry({ clinId: clinA.id, slinId: s1.id, entryDate: D1, hours: '8' });             // priced: 8 × 90 = 720
    const [s2] = await db().insert(schema.slins).values({ clinId: clinA.id, slinNumber: 'SD' }).returning();
    await entry({ clinId: clinA.id, slinId: s2.id, entryDate: D2, hours: '3' });             // unpriced (no category on SD, none at CLIN level)
    const c = (await getContractSummaries()).find((x) => x.contractId === contract.id)!;
    const clin = c.clinSummaries.find((x) => x.clinId === clinA.id)!;
    expect(clin.slinSummaries.find((x) => x.slinId === s1.id)).toMatchObject({ totalCost: 720, unpricedHours: 0, totalHours: 8 });
    expect(clin.slinSummaries.find((x) => x.slinId === s2.id)).toMatchObject({ totalCost: 0, unpricedHours: 3, totalHours: 3 });
    const summary = (await getEmployeeSummaryReport(...RANGE)).find((r) => r.employeeId === emp.id)!;
    expect(summary).toMatchObject({ totalHours: 11, totalCost: 720, unpricedHours: 3 });
  });

  it('a deactivated labor category keeps its historical cost (no status filter)', async () => {
    const old = await lcat(clinA.id, 'OLD', '90.00', { status: 'inactive' });
    await assign(emp.id, old.id, '2026-01-01', '2026-03-31');
    await entry({ clinId: clinA.id });
    expect((await getDetailedCostReport(...RANGE))[0]).toMatchObject({ lcatCode: 'OLD', totalCost: 720, costBasis: 'priced' });
  });

  it('promotion: end yesterday, start today — each day priced at its own category, no overlap', async () => {
    const jr = await lcat(clinA.id, 'JR', '80.00');
    const sr = await lcat(clinA.id, 'SR', '110.00');
    const a = await assign(emp.id, jr.id, '2026-01-01');
    await expectOk(endUserLaborCategoryAssignment(a.id, D1));
    await assign(emp.id, sr.id, D2);
    await entry({ clinId: clinA.id, entryDate: D1 });
    await entry({ clinId: clinA.id, entryDate: D2 });
    const rows = await getDetailedCostReport(...RANGE);
    expect(rows.map((r) => [r.entryDate, r.lcatCode, r.totalCost])).toEqual([[D1, 'JR', 640], [D2, 'SR', 880]]);
    expect(await getOverlappingAssignmentsReport()).toEqual([]);
    await expectFailure(endUserLaborCategoryAssignment(a.id, '2025-12-31' as CalendarDate), 'validation', /can't be before/);
  });

  it('v1 /costs returns costBasis + unpricedHours per row and the total unpricedHours in meta (additive)', async () => {
    await entry({ clinId: clinA.id });
    const rawKey = `byt_${crypto.randomBytes(24).toString('hex')}`;
    await db().insert(schema.apiKeys).values({ name: 'k', keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'), keyPrefix: rawKey.slice(0, 8), createdByUserId: admin.id, permissions: 'read', isActive: true });
    const res = await getV1Costs(new Request(`http://localhost:3000/api/v1/costs?startDate=${RANGE[0]}&endDate=${RANGE[1]}`, { headers: { Authorization: `Bearer ${rawKey}`, 'x-forwarded-for': '203.0.113.63' } }) as never);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ costBasis: 'unpriced', unpricedHours: 8, totalCost: 0, totalHours: 8 });
    expect(body.meta).toMatchObject({ unpricedHours: 8, total: 1 });
  });

  // ── Charge code ───────────────────────────────────────────────────────────
  it('changing CLIN/SLIN of a used code is refused; unchanged clinId accepted; unused code editable; LCAT change on a used code logged', async () => {
    const used = await createTestChargeCode(clinA.id);
    const unused = await createTestChargeCode(clinA.id);
    await entry({ chargeCodeId: used.id, clinId: clinA.id });
    await expectFailure(updateChargeCode(used.id, { clinId: clinB.id }), 'validation', /CLIN and SLIN can't change/);
    await expectOk(updateChargeCode(used.id, { clinId: clinA.id, name: 'Renamed' }));
    await expectOk(updateChargeCode(unused.id, { clinId: clinB.id }));
    const lc = await lcat(clinA.id, 'L', '10.00');
    await expectOk(updateChargeCode(used.id, { laborCategoryId: lc.id }));
    const log = await db().select().from(schema.adminChangeLog).where(eq(schema.adminChangeLog.entityId, used.id));
    expect(log).toEqual([expect.objectContaining({ entity: 'charge_code', action: 'labor_category_changed', oldValue: { laborCategoryId: null }, newValue: { laborCategoryId: lc.id } })]);
  });

  it('CLIN change racing a first save (separate connections): the save uses the in-transaction CLIN — never a stale one', async () => {
    const code = await createTestChargeCode(clinA.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    await db().insert(schema.userAssignments).values({ userId: emp.id, clinId: clinA.id, isActive: true });
    const today = todayIn('America/New_York');
    const start = getPeriodStartForDate(today, DEFAULT_PERIOD_CONFIG);
    writers.perCall = true;
    for (let round = 0; round < 3; round++) {
      await db().update(schema.chargeCodes).set({ clinId: clinA.id }).where(eq(schema.chargeCodes.id, code.id));
      const dayIndex = diffDays(start, today);
      const [upd, save] = await Promise.all([
        als.run(as(admin), () => updateChargeCode(code.id, { clinId: clinB.id })),
        als.run(as(emp), () => saveTimesheetBatch({ periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex, hours: round + 1, isEdit: round > 0, isLateEntry: false }], ...(round > 0 ? { changeReasonCode: 'CORRECTION', comment: 'race' } : {}) })),
      ]);
      expect(save.ok, JSON.stringify(save)).toBe(true);
      const [stored] = await db().select().from(schema.chargeCodes).where(eq(schema.chargeCodes.id, code.id));
      const rows = await db().select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, code.id));
      if (upd.ok) {
        // The update won: it committed before the save's FOR SHARE re-read, so the save used the NEW CLIN. Only possible
        // while the code had no entries (round 0).
        expect(round).toBe(0);
        expect(stored.clinId).toBe(clinB.id);
        expect(rows.every((r) => r.clinId === clinB.id)).toBe(true);
        break;
      }
      // The save won (or entries already existed): the update was refused and every entry is on CLIN A.
      expect(upd.error).toMatch(/CLIN and SLIN can't change/);
      expect(stored.clinId).toBe(clinA.id);
      expect(rows.every((r) => r.clinId === clinA.id)).toBe(true);
    }
  });

  // ── Corrections (CO-D8): reactivation ─────────────────────────────────────
  it('reactivateChargeCode logs, gives the code back to still-assigned employees, but only while its CLIN and contract are active', async () => {
    const code = await createTestChargeCode(clinA.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    // F11: a deactivated employee's assignment is not counted (they don't see the code again).
    const gone = await createTestUser({ role: 'employee', isActive: false });
    await db().insert(schema.userChargeCodes).values({ userId: gone.id, chargeCodeId: code.id, isActive: true });
    await expectOk(deactivateChargeCode(code.id));
    session.user = as(emp);
    expect((await getChargeCodesForUser()).map((c) => c.id)).not.toContain(code.id);
    session.user = as(admin);
    expect(await expectOk(reactivateChargeCode(code.id))).toEqual({ stillAssigned: 1 });
    session.user = as(emp);
    expect((await getChargeCodesForUser()).map((c) => c.id)).toContain(code.id);
    await db().update(schema.clins).set({ status: 'inactive' }).where(eq(schema.clins.id, clinA.id));
    expect((await getChargeCodesForUser()).map((c) => c.id)).not.toContain(code.id);
    const log = await db().select().from(schema.adminChangeLog).where(eq(schema.adminChangeLog.entityId, code.id));
    expect(log.map((l) => l.action)).toEqual(['deactivated', 'reactivated']);
    expect(log[1].newValue).toEqual({ isActive: true, stillAssigned: 1 });
  });
});
