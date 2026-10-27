import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, assignUserToClin, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-navigation-home.md §4.5 / T9: getHomeData — the role comes from fresh facts (a DB employee is sent to
 * the timesheet; a DB supervisor gets no admin parts and the admin internals never run); setup runs after the main
 * burst; every "Needs your attention" item fires on a fixture that needs it and none fire on a clean one; the unpriced
 * total equals the unpriced report and each contract's money equals the Dashboard's.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000e9', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));

type FakeUser = { id: string; role: 'admin' | 'supervisor' | 'employee'; email: string; fullName: string };
const h = vi.hoisted(() => {
  const log: string[] = [];
  // Wraps an internal so the test sees whether (and when) it ran.
  const track = <A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>) =>
    vi.fn(async (...a: A) => { log.push(`start:${name}`); try { return await f(...a); } finally { log.push(`end:${name}`); } });
  return { log, track, session: { user: null as null | FakeUser } };
});
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => { if (!h.session.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session'); return h.session.user; };
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), requireAdmin: async () => current() };
});
vi.mock('@/server/internal/workspace-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/workspace-settings')>();
  return { ...actual, getWorkspaceToday: async () => '2026-10-07', workweekStartDayInternal: h.track('workweek', actual.workweekStartDayInternal) };
});
vi.mock('@/server/internal/dashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/dashboard')>();
  return { ...actual, contractBurnSummary: h.track('contracts', actual.contractBurnSummary) };
});
vi.mock('@/server/internal/approval-notices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/approval-notices')>();
  return { ...actual, approvalNotices: h.track('notices', actual.approvalNotices) };
});
vi.mock('@/server/internal/setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/setup')>();
  return { ...actual, getSetupStatusInternal: h.track('setup', actual.getSetupStatusInternal) };
});
vi.mock('@/server/internal/pay-period-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/pay-period-config')>();
  return { ...actual, pendingConfigChangeInternal: h.track('pendingConfig', actual.pendingConfigChangeInternal) };
});
vi.mock('@/server/internal/cost-basis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/cost-basis')>();
  return { ...actual, overlappingAssignments: h.track('overlaps', actual.overlappingAssignments) };
});
vi.mock('@/server/internal/team-period-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/team-period-status')>();
  return { ...actual, teamPeriodStatus: h.track('team', actual.teamPeriodStatus) };
});
vi.mock('@/server/internal/approval-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/approval-queue')>();
  return { ...actual, approvalQueue: h.track('waiting', actual.approvalQueue) };
});
vi.mock('@/server/internal/employee-dashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/employee-dashboard')>();
  return { ...actual, currentPeriodSummary: h.track('myPeriod', actual.currentPeriodSummary) };
});

import { getHomeData } from '@/server/internal/home';
import { attentionItems, burnCard, type HomeView } from '@/lib/home/attention';
import { unpricedEntries } from '@/server/internal/cost-basis';
import { getContractSummaries } from '@/server/actions/dashboard';

const EARLY = new Date('2026-01-01T12:00:00Z');
const ADMIN_ONLY = ['notices', 'contracts', 'workweek', 'pendingConfig', 'overlaps', 'setup'];

describe('getHomeData (T9)', () => {
  const db = () => getTestDb();
  const user = (fullName: string, role: 'admin' | 'supervisor' | 'employee', o: Partial<typeof schema.users.$inferInsert> = {}) =>
    createTestUser({ fullName, role, createdAt: EARLY, ...o });
  const lcat = async (clinId: string, code: string, rate: string) =>
    (await db().insert(schema.laborCategories).values({ clinId, lcatCode: code, title: code, hourlyRate: rate }).returning())[0];
  const entry = (userId: string, chargeCodeId: string, clinId: string, hours: string, entryDate = '2026-09-02', revisionNumber = 1) =>
    db().insert(schema.timesheetEntries).values({ userId, chargeCodeId, clinId, entryDate, hours, revisionNumber, createdBy: userId, ...(revisionNumber > 1 ? { changeReasonCode: 'CORRECTION', comment: 'x' } : {}) });
  const period = (userId: string, periodStart: string, status: 'submitted' | 'approved') =>
    db().insert(schema.timesheetPeriods).values({ userId, periodStart, status, periodNumDays: 15, submissionCount: 1, submittedAt: new Date('2026-10-02T10:00:00Z') });
  const view = (r: Awaited<ReturnType<typeof getHomeData>>): HomeView => { if ('redirect' in r) throw new Error('unexpected redirect'); return r; };

  beforeEach(async () => { await cleanupTestData(); h.log.length = 0; vi.clearAllMocks(); });
  afterEach(async () => { h.session.user = null; await cleanupTestData(); });

  it('a DB employee (whatever the JWT said) and an inactive admin are sent to the timesheet', async () => {
    const emp = await user('Eve Emp', 'employee');
    const gone = await user('Gone Admin', 'admin', { isActive: false });
    expect(await getHomeData(emp.id)).toEqual({ redirect: '/timesheet' });
    expect(await getHomeData(gone.id)).toEqual({ redirect: '/timesheet' });
  });

  it('the DB role decides: a user whose DB role is now supervisor (whatever their session says) gets no admin parts and no money', async () => {
    const was = await user('Wes Was', 'admin');
    await user('Ann Admin', 'admin');
    await db().update(schema.users).set({ role: 'supervisor' }).where(eq(schema.users.id, was.id));
    const v = view(await getHomeData(was.id));
    expect(v.role).toBe('supervisor');
    expect(v.admin).toBeNull();
    for (const name of ADMIN_ONLY) expect(h.log, name).not.toContain(`start:${name}`);
  });

  it('a supervisor: no admin parts, the admin internals never run, and names are limited to their team', async () => {
    const sup = await user('Sam Super', 'supervisor');
    const mine = await user('Mia Mine', 'employee');
    await user('Oscar Other', 'employee');
    await user('Ann Admin', 'admin');
    const clin = await createTestClin((await createTestContract()).id);
    for (const u of [sup, mine]) await assignUserToClin(u.id, clin.id);
    await period(mine.id, '2026-10-01', 'submitted');

    const v = view(await getHomeData(sup.id));
    expect(v.role).toBe('supervisor');
    expect(v.admin).toBeNull();
    for (const name of ADMIN_ONLY) expect(h.log, name).not.toContain(`start:${name}`);
    expect(v.waiting).toMatchObject({ count: 1, names: ['Mia Mine'] });
    expect([...v.lastTeam.notStarted.names, ...v.lastTeam.inProgress.names, ...v.lastTeam.returned.names, ...v.lastTeam.submitted.names]).toEqual(['Mia Mine']);
    expect(v.team.submitted.names).toEqual(['Mia Mine']);
    expect(attentionItems(v).map((i) => i.key)).toEqual(['waiting', 'last-period']);
  });

  it('an admin: every attention item fires on a fixture that needs it; setup runs after the main burst', async () => {
    const admin = await user('Ann Admin', 'admin');                              // the only active admin, no designee
    const emp = await user('Eve Emp', 'employee');
    const contract = await createTestContract({ name: 'Navy', fundedValue: '1000' });
    const clin = await createTestClin(contract.id);
    await assignUserToClin(emp.id, clin.id);
    const priced = await createTestChargeCode(clin.id, { laborCategoryId: (await lcat(clin.id, 'PRICE', '100.00')).id });
    const bare = await createTestChargeCode(clin.id);
    await entry(emp.id, priced.id, clin.id, '8');                                // $800 of $1,000 → Watch
    await entry(emp.id, bare.id, clin.id, '2');                                  // unpriced
    const [l2, l3] = [await lcat(clin.id, 'SE2', '90.00'), await lcat(clin.id, 'SE3', '95.00')];
    await db().insert(schema.userLaborCategories).values([
      { userId: emp.id, laborCategoryId: l2.id, effectiveDate: '2026-01-01' },
      { userId: emp.id, laborCategoryId: l3.id, effectiveDate: '2026-02-01' }, // overlap
    ]);
    await period(emp.id, '2026-10-01', 'submitted');                             // waiting; nothing for Sep 16 → straggler
    await db().insert(schema.payPeriodConfig).values({ periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '2026-11-01' });
    // No charge-code access → setup incomplete; workweek unset (cleanup resets it).

    const v = view(await getHomeData(admin.id));
    expect(attentionItems(v).map((i) => i.key)).toEqual(['waiting', 'last-period', 'unpriced', 'self-approval', 'setup', 'workweek', 'pay-schedule', 'contracts', 'overlaps']);
    expect(v.admin).toMatchObject({ unpricedTotal: 2, workweekSet: false, pendingConfig: { effectiveFrom: '2026-11-01' }, overlaps: 1, notices: { recommendDesignee: true, selfApprovalBackOn: null } });
    expect(v.admin!.setup).toMatchObject({ isComplete: false, done: 5 });

    const burstEnds = h.log.filter((l) => l.startsWith('end:') && l !== 'end:setup').map((l) => h.log.indexOf(l));
    expect(h.log).toContain('start:setup');
    expect(h.log.indexOf('start:setup')).toBeGreaterThan(Math.max(...burstEnds));
  });

  it('a clean admin workspace: nothing needs attention', async () => {
    const admin = await user('Ann Admin', 'admin');
    await user('Abe Admin', 'admin');                                            // a second active admin
    const emp = await user('Eve Emp', 'employee');
    const contract = await createTestContract({ fundedValue: '100000' });
    const clin = await createTestClin(contract.id);
    const code = await createTestChargeCode(clin.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id });
    await period(emp.id, '2026-09-16', 'approved');
    await db().update(schema.workspaceSettings).set({ workweekStartDay: 1 });

    const v = view(await getHomeData(admin.id));
    expect(v.admin!.setup.isComplete).toBe(true);
    expect(attentionItems(v)).toEqual([]);
  });

  it('unpriced total = the unpriced report (all contracts); each contract equals the Dashboard (per-CLIN cent rounding)', async () => {
    const admin = await user('Ann Admin', 'admin');
    const emp = await user('Eve Emp', 'employee');
    h.session.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
    const active = await createTestContract({ name: 'Active', fundedValue: '1000' });
    const [clinA, clinB] = [await createTestClin(active.id), await createTestClin(active.id)];
    for (const clin of [clinA, clinB]) {
      const code = await createTestChargeCode(clin.id, { laborCategoryId: (await lcat(clin.id, `R${clin.id.slice(0, 4)}`, '123.45')).id });
      await entry(emp.id, code.id, clin.id, '0.25');                             // 30.8625 → 30.86 per CLIN
    }
    const bareA = (await createTestChargeCode(clinA.id)).id;
    await entry(emp.id, bareA, clinA.id, '1.5');
    await entry(emp.id, bareA, clinA.id, '4', '2026-09-03');                     // corrected: 4 → 1
    await entry(emp.id, bareA, clinA.id, '1', '2026-09-03', 2);
    await entry(emp.id, bareA, clinA.id, '5', '2026-09-04');                     // cleared: 5 → 0
    await entry(emp.id, bareA, clinA.id, '0', '2026-09-04', 2);
    const clinD = await createTestClin(active.id);                               // a conflict: two categories at once
    const [x, y] = [await lcat(clinD.id, 'X', '80.00'), await lcat(clinD.id, 'Y', '85.00')];
    await db().insert(schema.userLaborCategories).values([
      { userId: emp.id, laborCategoryId: x.id, effectiveDate: '2026-01-01' },
      { userId: emp.id, laborCategoryId: y.id, effectiveDate: '2026-01-01' },
    ]);
    await entry(emp.id, (await createTestChargeCode(clinD.id)).id, clinD.id, '2');
    const closed = await createTestContract({ name: 'Closed', status: 'inactive' });
    const clinC = await createTestClin(closed.id);
    await entry(emp.id, (await createTestChargeCode(clinC.id)).id, clinC.id, '3');

    const v = view(await getHomeData(admin.id));
    const report = await unpricedEntries(db(), {});
    expect(v.admin!.unpricedTotal).toBe(Math.round(report.rows.reduce((s, r) => s + r.hours, 0) * 100) / 100);
    expect(v.admin!.unpricedTotal).toBe(7.5);                                    // 1.5 + 1 (corrected) + 0 (cleared) + 2 (conflict) + 3 (inactive contract)
    expect(report.rows.some((r) => r.reason === 'conflict')).toBe(true);
    const dashboard = await getContractSummaries();
    for (const c of v.admin!.contracts) {
      const d = dashboard.find((x) => x.contractId === c.contractId)!;
      expect({ cost: c.pricedCost, unpriced: c.unpricedHours }, c.contractName).toEqual({ cost: d.totalCost, unpriced: d.unpricedHours });
    }
    expect(v.admin!.contracts.find((c) => c.contractName === 'Active')!.pricedCost).toBe(61.72);
    expect(burnCard(v.admin!.contracts).map((c) => c.contractName)).toEqual(['Active']); // the card is active-only
  });
});

describe('home/page.tsx (T9 static, L9)', () => {
  it('passes only user.id to getHomeData — never the session role or the user object', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/(app)/home/page.tsx'), 'utf8');
    const calls = [...src.matchAll(/getHomeData\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls).toEqual(['user.id']);
  });
});
