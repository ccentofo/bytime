import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-navigation-home.md §4.7 / T14 (UX-AUDIT B1), rewritten for feature-plan-ux-setup-import.md §3.1:
 * charge code access counts only active assignments to a CHARGEABLE code (what makes a direct timesheet row appear).
 * SU-2 — the pay schedule step is done by a pay_period_config row OR timesheet data; not otherwise.
 * SU-3 — charge code access is done when anyone is covered; w < m keeps it done and the page loader names the others.
 * SU-4 — isComplete is false while any required step isn't done (workweek unset with everything else done); true with an
 *        indirect-only person uncovered.
 * SU-9 — an admin-only workspace: an admin with a chargeable code completes People and Charge code access.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000b1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));

import { getSetupStatusInternal, getSetupAccessGapsInternal, getSetupPageDataInternal } from '@/server/internal/setup';

describe('Setup status (B1, feature-plan-ux-setup-import.md §3.1)', () => {
  const db = () => getTestDb();
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let clin: Awaited<ReturnType<typeof createTestClin>>;
  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin' });
    emp = await createTestUser({ role: 'employee' });
    clin = await createTestClin((await createTestContract()).id);
  });
  afterEach(async () => { await cleanupTestData(); });

  const grant = async (userId: string, chargeCodeId: string) => db().insert(schema.userChargeCodes).values({ userId, chargeCodeId, isActive: true });
  const step = (st: Awaited<ReturnType<typeof getSetupStatusInternal>>, key: string) => st.steps.find((s) => s.key === key)!;
  /** The two settings steps done: workweek set, and a pay schedule row. */
  async function settingsDone() {
    await db().update(schema.workspaceSettings).set({ workweekStartDay: 1 }).where(eq(schema.workspaceSettings.id, 1));
    await db().insert(schema.payPeriodConfig).values({ periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '1900-01-01' });
  }

  it('B1 repro: contract + CLIN + employee + a CLIN membership row, no charge-code access → access not done, incomplete', async () => {
    await settingsDone();
    await db().insert(schema.userAssignments).values({ userId: emp.id, clinId: clin.id, isActive: true });
    const st = await getSetupStatusInternal();
    expect(st.counts).toMatchObject({ contracts: 1, clins: 1, chargeCodes: 0, employees: 1, employeesWithAccess: 0 });
    expect(step(st, 'chargeCodeAccess')).toEqual({ key: 'chargeCodeAccess', done: false, required: true, withAccess: 0, total: 1 });
    expect(st.isComplete).toBe(false);
  });

  it('SU-2: the pay schedule step is done by a pay_period_config row, or by timesheet data; not otherwise', async () => {
    expect(step(await getSetupStatusInternal(), 'paySchedule').done).toBe(false);
    await db().insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: '2026-01-01', status: 'draft', periodNumDays: 15 });
    let st = await getSetupStatusInternal();
    expect([step(st, 'paySchedule').done, st.hasTimesheetData, st.payConfigSet]).toEqual([true, true, false]);
    await cleanupTestData();
    await createTestUser({ role: 'admin' });
    await db().insert(schema.payPeriodConfig).values({ periodType: 'weekly', anchorDate: '2026-01-05', weekStartDay: 1, effectiveFrom: '1900-01-01' });
    st = await getSetupStatusInternal();
    expect([step(st, 'paySchedule').done, st.hasTimesheetData, st.payConfigSet]).toEqual([true, false, true]);
  });

  it('SU-4: workweek unset with everything else done → incomplete (5 of 6); set → complete, with an indirect-only person uncovered', async () => {
    const code = await createTestChargeCode(clin.id);
    await grant(emp.id, code.id);
    await createTestUser({ role: 'employee', fullName: 'Ivy Indirect-Only' });   // charges only indirect codes
    await db().insert(schema.payPeriodConfig).values({ periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '1900-01-01' });
    let st = await getSetupStatusInternal();
    expect([step(st, 'timeAndWeek').done, st.requiredDone, st.requiredTotal, st.isComplete]).toEqual([false, 5, 6, false]);
    await db().update(schema.workspaceSettings).set({ workweekStartDay: 1 }).where(eq(schema.workspaceSettings.id, 1));
    st = await getSetupStatusInternal();
    expect([st.requiredDone, st.isComplete]).toEqual([6, true]);
    expect(step(st, 'chargeCodeAccess')).toMatchObject({ done: true, withAccess: 1, total: 2 });   // Ivy uncovered: not blocking
  });

  it('SU-3: anyone covered → done; w < m keeps it done and the page loader names the others (never the status)', async () => {
    const code = await createTestChargeCode(clin.id);
    const sup = await createTestUser({ role: 'supervisor', fullName: 'Sam Supervisor' });
    await db().update(schema.users).set({ fullName: 'Ann Employee' }).where(eq(schema.users.id, emp.id));
    expect(step(await getSetupStatusInternal(), 'chargeCodeAccess').done).toBe(false);
    await grant(emp.id, code.id);
    const st = await getSetupStatusInternal();
    expect(step(st, 'chargeCodeAccess')).toMatchObject({ done: true, withAccess: 1, total: 2 });
    expect(JSON.stringify(st)).not.toContain('Sam Supervisor');
    const page = await getSetupPageDataInternal();
    expect(page.gaps).toEqual({ missingCount: 1, names: ['Sam Supervisor'] });
    void sup;
  });

  it('SU-9: an admin-only workspace — an admin with a chargeable code completes People and Charge code access', async () => {
    await db().update(schema.users).set({ isActive: false }).where(eq(schema.users.id, emp.id));
    let st = await getSetupStatusInternal();
    expect([step(st, 'people').done, step(st, 'chargeCodeAccess').done]).toEqual([false, false]);
    await grant(admin.id, (await createTestChargeCode(clin.id)).id);
    st = await getSetupStatusInternal();
    expect([step(st, 'people').done, step(st, 'chargeCodeAccess').done]).toEqual([true, true]);
    expect(step(st, 'chargeCodeAccess')).toMatchObject({ withAccess: 1, total: 1 });
    expect(st.counts).toMatchObject({ employees: 0, adminsWithAccess: 1 });
  });

  it('inactive employee, inactive assignment, inactive code, or an inactive SLIN on the only code → access not done', async () => {
    const code = await createTestChargeCode(clin.id);
    await grant(emp.id, code.id);
    const covered = async () => step(await getSetupStatusInternal(), 'chargeCodeAccess').done;
    expect(await covered()).toBe(true);
    await db().update(schema.users).set({ isActive: false }).where(eq(schema.users.id, emp.id));
    expect(await covered()).toBe(false);
    await db().update(schema.users).set({ isActive: true }).where(eq(schema.users.id, emp.id));
    await db().update(schema.userChargeCodes).set({ isActive: false }).where(eq(schema.userChargeCodes.userId, emp.id));
    expect(await covered()).toBe(false);
    await db().update(schema.userChargeCodes).set({ isActive: true }).where(eq(schema.userChargeCodes.userId, emp.id));
    await db().update(schema.chargeCodes).set({ isActive: false }).where(eq(schema.chargeCodes.id, code.id));
    expect((await getSetupStatusInternal()).counts.chargeCodes).toBe(0);
    expect(await covered()).toBe(false);
    await db().update(schema.chargeCodes).set({ isActive: true }).where(eq(schema.chargeCodes.id, code.id));
    const [slin] = await db().insert(schema.slins).values({ clinId: clin.id, slinNumber: 'S1', status: 'inactive' }).returning();
    await db().update(schema.chargeCodes).set({ slinId: slin.id }).where(eq(schema.chargeCodes.id, code.id));
    expect(await covered()).toBe(false);
    await db().update(schema.slins).set({ status: 'active' }).where(eq(schema.slins.id, slin.id));
    expect(await covered()).toBe(true);
  });

  it('counts: two codes for one employee count once; inactive parents don\'t count; CLINs without a code; a connection', async () => {
    const a = await createTestChargeCode(clin.id);
    const b = await createTestChargeCode(clin.id);
    await grant(emp.id, a.id);
    await grant(emp.id, b.id);
    const emp2 = await createTestUser({ role: 'employee' });
    const otherClin = await createTestClin((await createTestContract({ status: 'inactive' })).id);
    await grant(emp2.id, (await createTestChargeCode(otherClin.id)).id);
    await createTestClin(clin.contractId);                                         // an active CLIN with no code
    const onlyInactive = await createTestClin(clin.contractId);                    // UX-4C2A-AUDIT.md L6: only an inactive code
    await createTestChargeCode(onlyInactive.id, { isActive: false });
    const st = await getSetupStatusInternal();
    expect(st.counts).toMatchObject({ employees: 2, employeesWithAccess: 1, chargeCodes: 2, contracts: 1, clins: 4, clinsWithoutCode: 2 });
    expect(step(st, 'connection').done).toBe(false);
    await db().insert(schema.integrationConnections).values({ provider: 'quickbooks_online', displayName: 'QuickBooks — Acme', connectedBy: admin.id });
    expect(step(await getSetupStatusInternal(), 'connection').done).toBe(true);
  });

  // feature-plan-ux-page-fixes.md C17 / T-C17c (integration half) --------------------------------------------------
  it('C17: an inactive assignment or a non-chargeable code still counts as missing; admins and inactive users are never listed', async () => {
    const live = await createTestChargeCode(clin.id);
    const deadClin = await createTestClin((await createTestContract({ status: 'inactive' })).id);
    const dead = await createTestChargeCode(deadClin.id);
    const e2 = await createTestUser({ role: 'employee', fullName: 'Bob Dead-Code' });
    const e3 = await createTestUser({ role: 'employee', fullName: 'Cat Inactive-Assignment' });
    const gone = await createTestUser({ role: 'employee', fullName: 'Dan Gone' });
    await db().update(schema.users).set({ isActive: false }).where(eq(schema.users.id, gone.id));
    await grant(emp.id, live.id);
    await grant(e2.id, dead.id);
    await db().insert(schema.userChargeCodes).values({ userId: e3.id, chargeCodeId: live.id, isActive: false });
    const gaps = await getSetupAccessGapsInternal();
    expect(gaps).toEqual({ missingCount: 2, names: ['Bob Dead-Code', 'Cat Inactive-Assignment'] });
  });

  it('S10 (UX-4C2A-AUDIT.md): the page data carries the time zone\'s friendly name; an unknown id falls back to itself', async () => {
    await db().update(schema.workspaceSettings).set({ timezone: 'America/Chicago' }).where(eq(schema.workspaceSettings.id, 1));
    expect((await getSetupPageDataInternal()).settings).toMatchObject({ timezone: 'America/Chicago', timezoneLabel: 'Central Time' });
    await db().update(schema.workspaceSettings).set({ timezone: 'Mars/Olympus_Mons' }).where(eq(schema.workspaceSettings.id, 1));
    expect((await getSetupPageDataInternal()).settings.timezoneLabel).toBe('Mars/Olympus_Mons');
  });

  it('C17: the gaps list stops at 20 names (by name) while missingCount counts everyone', async () => {
    for (let i = 0; i < 22; i++) await createTestUser({ role: 'employee', fullName: `Person ${String(i).padStart(2, '0')}` });
    const gaps = await getSetupAccessGapsInternal();
    expect(gaps.missingCount).toBe(23);                          // + emp from beforeEach
    expect(gaps.names).toHaveLength(20);
    expect(gaps.names).toEqual([...gaps.names].sort((a, b) => a.localeCompare(b)));
  });
});
