import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode, cleanupTestData, expectFailure,
} from './helpers';

/**
 * feature-plan-certified-outputs.md C4 / §9 rows "Grid assignable", "Grid/review", "Corrections (CO-D8)", "Leave
 * pre-set" (0-hour correction on a deactivated code), "Display" (grid/review provenance): the per-period code list,
 * the per-cell rule in saveTimesheetBatch, and the review, against real Postgres through the real actions.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000c4', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
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
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), assertCanAccessEmployee: async () => {}, getEmployeeScope: async () => 'all' };
});

import { getTimesheetPeriod, getTimesheetForReview, saveTimesheetBatch } from '@/server/actions/timesheet';

const as = (u: { id: string; role: string; email: string; fullName: string }): FakeUser => ({ id: u.id, role: u.role as FakeUser['role'], email: u.email, fullName: u.fullName });
const fix = { changeReasonCode: 'CORRECTION', comment: 'fix' };

describe('grid corrections (certified-outputs C4)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let clin: Awaited<ReturnType<typeof createTestClin>>;
  let start: CalendarDate;      // the PREVIOUS period: every day is in the past
  let other: CalendarDate;      // the period before that (no hours)
  const db = () => getTestDb();
  const entry = (o: Partial<typeof schema.timesheetEntries.$inferInsert>) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, entryDate: start, hours: '8', revisionNumber: 1, createdBy: emp.id, ...o });
  const latest = async (where: ReturnType<typeof and>) =>
    (await db().select().from(schema.timesheetEntries).where(where)).sort((a, b) => b.revisionNumber - a.revisionNumber)[0];

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    emp = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    clin = await createTestClin(contract.id);
    const current = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    start = getPeriodStartForDate(addDays(current, -1), DEFAULT_PERIOD_CONFIG);
    other = getPeriodStartForDate(addDays(start, -1), DEFAULT_PERIOD_CONFIG);
    session.user = as(emp);
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('deactivated charge code: the row stays (read-only for new days), a new day is refused, an existing day is corrected — even to 0', async () => {
    const code = await createTestChargeCode(clin.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    await entry({ chargeCodeId: code.id, clinId: clin.id });
    await db().update(schema.chargeCodes).set({ isActive: false }).where(eq(schema.chargeCodes.id, code.id));

    const period = await getTimesheetPeriod(start);
    expect(period.chargeCodes.find((c) => c.id === code.id)).toMatchObject({ kind: 'charge', assignable: false });
    expect(period.entries.find((e) => e.chargeCodeId === code.id)?.hours[0]).toBe(8);

    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 1, hours: 4, isEdit: false, isLateEntry: true }], ...fix }), 'validation', /no longer active/);
    const r = await saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 0, hours: 0, isEdit: true, isLateEntry: false }], ...fix });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const zeroed = await latest(and(eq(schema.timesheetEntries.chargeCodeId, code.id), eq(schema.timesheetEntries.entryDate, start)));
    expect(zeroed).toMatchObject({ revisionNumber: 2, changeReasonCode: 'CORRECTION', clinId: clin.id });
    expect(Number(zeroed.hours).toFixed(2)).toBe('0.00'); // T7: the database stores hours as saved
    // The 0-hour row is still in the period's list (recorded), so the correction stays visible.
    expect((await getTimesheetPeriod(start)).chargeCodes.map((c) => c.id)).toContain(code.id);
  });

  it('T17 (B5): SLIN deactivated — new day refused naming the SLIN; a mixed batch writes nothing; the correction alone succeeds; reactivated → new days allowed', async () => {
    const [slin] = await db().insert(schema.slins).values({ clinId: clin.id, slinNumber: 'B5AA' }).returning();
    const code = await createTestChargeCode(clin.id, { slinId: slin.id });
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    await entry({ chargeCodeId: code.id, clinId: clin.id, slinId: slin.id });
    await db().update(schema.slins).set({ status: 'inactive' }).where(eq(schema.slins.id, slin.id));
    const count = async () => (await db().select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, code.id))).length;

    expect((await getTimesheetPeriod(start)).chargeCodes.find((c) => c.id === code.id)).toMatchObject({ kind: 'charge', assignable: false });
    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 1, hours: 4, isEdit: false, isLateEntry: true }], ...fix }), 'validation', /no longer active \(or its CLIN, SLIN or contract isn't\)/);

    // All-or-nothing: a new cell on the closed SLIN + a valid correction → the whole save is refused, nothing written.
    const before = await count();
    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [
      { chargeCodeId: code.id, dayIndex: 0, hours: 5, isEdit: true, isLateEntry: false },
      { chargeCodeId: code.id, dayIndex: 2, hours: 3, isEdit: false, isLateEntry: true },
    ], ...fix }), 'validation', /SLIN/);
    expect(await count()).toBe(before);

    const r = await saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 0, hours: 5, isEdit: true, isLateEntry: false }], ...fix });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await count()).toBe(before + 1);

    await db().update(schema.slins).set({ status: 'active' }).where(eq(schema.slins.id, slin.id));
    expect((await getTimesheetPeriod(start)).chargeCodes.find((c) => c.id === code.id)).toMatchObject({ assignable: true });
    const again = await saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 1, hours: 4, isEdit: false, isLateEntry: true }], ...fix });
    expect(again.ok, JSON.stringify(again)).toBe(true);
  });

  it('unassigned charge code: shown only in periods where it has hours; new day refused (forbidden), correction allowed with a reason', async () => {
    const code = await createTestChargeCode(clin.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: false });
    await entry({ chargeCodeId: code.id, clinId: clin.id });

    expect((await getTimesheetPeriod(start)).chargeCodes.find((c) => c.id === code.id)).toMatchObject({ assignable: false });
    expect((await getTimesheetPeriod(other)).chargeCodes.map((c) => c.id)).not.toContain(code.id);

    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 2, hours: 4, isEdit: false, isLateEntry: true }], ...fix }), 'forbidden', /not assigned to charge code/);
    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 0, hours: 6, isEdit: true, isLateEntry: false }] }), 'validation', /reason code is required/);
    const r = await saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 0, hours: 6, isEdit: true, isLateEntry: false }], ...fix });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('T1: assigned, active charge code whose CLIN — then whose contract — is inactive: new day refused, existing day correctable', async () => {
    const contract = await createTestContract();
    const c2 = await createTestClin(contract.id);
    const code = await createTestChargeCode(c2.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    await entry({ chargeCodeId: code.id, clinId: c2.id });
    for (const deactivate of [
      () => db().update(schema.clins).set({ status: 'inactive' }).where(eq(schema.clins.id, c2.id)),
      async () => {
        await db().update(schema.clins).set({ status: 'active' }).where(eq(schema.clins.id, c2.id));
        await db().update(schema.contracts).set({ status: 'inactive' }).where(eq(schema.contracts.id, contract.id));
      },
    ]) {
      await deactivate();
      await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 3, hours: 2, isEdit: false, isLateEntry: true }], ...fix }), 'validation', /no longer active/);
      const r = await saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 0, hours: 3, isEdit: true, isLateEntry: false }], ...fix });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });

  it('a correction in a submitted period is refused (the period lock is unchanged)', async () => {
    const code = await createTestChargeCode(clin.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: false });
    await entry({ chargeCodeId: code.id, clinId: clin.id });
    await db().insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: start, status: 'submitted', submittedAt: new Date() });
    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 0, hours: 2, isEdit: true, isLateEntry: false }], ...fix }), 'validation', /locked|submitted/i);
  });

  it('legacy CLIN row (ruling Q1): listed as a CLIN row; a new day is refused; a correction keeps the recorded SLIN; a different SLIN is refused', async () => {
    const [slin] = await db().insert(schema.slins).values({ clinId: clin.id, slinNumber: 'AA' }).returning();
    const [slinB] = await db().insert(schema.slins).values({ clinId: clin.id, slinNumber: 'AB' }).returning();
    await entry({ clinId: clin.id, slinId: slin.id });

    expect((await getTimesheetPeriod(start)).chargeCodes.find((c) => c.id === clin.id)).toMatchObject({ kind: 'clin', assignable: false, clin: `CLIN ${clin.clinNumber}` });
    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ clinId: clin.id, dayIndex: 1, hours: 3, isEdit: false, isLateEntry: true }], ...fix }), 'validation', /CLIN-only row/);
    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ clinId: clin.id, slinId: slinB.id, dayIndex: 0, hours: 5, isEdit: true, isLateEntry: false }], ...fix }), 'validation', /keeps the SLIN/);
    const r = await saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ clinId: clin.id, dayIndex: 0, hours: 5, isEdit: true, isLateEntry: false }], ...fix });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const corrected = await latest(and(eq(schema.timesheetEntries.clinId, clin.id), eq(schema.timesheetEntries.entryDate, start)));
    expect(corrected).toMatchObject({ revisionNumber: 2, slinId: slin.id, chargeCodeId: null });
    expect(Number(corrected.hours).toFixed(2)).toBe('5.00'); // T7
  });

  it('inactive indirect code with hours: listed, corrected; new day refused', async () => {
    const ind = await createTestIndirectCode({ availableToAll: true });
    await entry({ indirectCodeId: ind.id });
    await db().update(schema.indirectChargeCodes).set({ isActive: false }).where(eq(schema.indirectChargeCodes.id, ind.id));
    expect((await getTimesheetPeriod(start)).chargeCodes.find((c) => c.id === ind.id)).toMatchObject({ kind: 'indirect', assignable: false });
    await expectFailure(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ indirectCodeId: ind.id, dayIndex: 1, hours: 2, isEdit: false, isLateEntry: true }], ...fix }), 'validation', /is not available/);
    expect((await saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ indirectCodeId: ind.id, dayIndex: 0, hours: 2, isEdit: true, isLateEntry: false }], ...fix })).ok).toBe(true);
  });

  it('F7: a charge cell whose revisions carry two clin_ids (pre-C3 CLIN change) — the revision map gives the latest, the save succeeds', async () => {
    const contract = await createTestContract();
    const clinB = await createTestClin(contract.id);
    const code = await createTestChargeCode(clin.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    await entry({ chargeCodeId: code.id, clinId: clinB.id, hours: '4' });                                  // rev 1 under the old CLIN
    await entry({ chargeCodeId: code.id, clinId: clin.id, hours: '6', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'x' });
    const period = await getTimesheetPeriod(start);
    expect(period.revisions[`${code.id}-0`]).toBe(2);
    const r = await saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [{ chargeCodeId: code.id, dayIndex: 0, hours: 7, isEdit: true, isLateEntry: false, expectedRevision: period.revisions[`${code.id}-0`] }], ...fix });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('the review shows every recorded hour (unassigned and legacy CLIN rows included) with provenance on imported cells', async () => {
    const code = await createTestChargeCode(clin.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: false });
    const [batch] = await db().insert(schema.importBatches).values({ kind: 'entries', sourceSystem: 'Deltek', importedBy: admin.id, rowCount: 1, importedCount: 1, skippedCount: 0 }).returning();
    await entry({ chargeCodeId: code.id, clinId: clin.id, source: 'migration', importBatchId: batch.id, originalMetadata: { enteredBy: 'Pat (Deltek)' } });
    await entry({ clinId: clin.id, entryDate: addDays(start, 1), hours: '3' });

    session.user = as(admin);
    const review = await getTimesheetForReview(emp.id, start);
    const total = review.entries.reduce((s, e) => s + e.hours.reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(11);
    const imported = review.entries.find((e) => e.chargeCodeId === code.id)!;
    expect(imported.provenance?.[0]).toMatch(/^Imported from Deltek on \d{4}-\d{2}-\d{2} by Ann Admin — originally entered by Pat \(Deltek\)$/);
    expect(review.chargeCodes.find((c) => c.id === clin.id)).toMatchObject({ kind: 'clin', assignable: false });
  });
});
