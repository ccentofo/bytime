import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, assignUserToClin, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-navigation-home.md §4.6 / T13: "Worth a look" — corrections (revision > 1), late entries (revision
 * 1 with a reason code), resubmitted (submission_count > 1); imported (source = 'migration') rows excluded; flags only
 * on rows the session user may decide (getScopedPeriods).
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000f1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
type FakeUser = { id: string; role: 'admin' | 'supervisor' | 'employee'; email: string; fullName: string };
const session = vi.hoisted(() => ({ user: null as null | FakeUser }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => { if (!session.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized'); return session.user; };
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), requireApprover: async () => current(), requireApproverFresh: async () => current() };
});

import { periodFlags } from '@/server/internal/period-flags';
import { getScopedPeriods } from '@/server/actions/periods';

describe('period flags (T13)', () => {
  const db = () => getTestDb();
  let sup: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let code: Awaited<ReturnType<typeof createTestChargeCode>>;
  let clinId: string;
  const entry = (o: Partial<typeof schema.timesheetEntries.$inferInsert>) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: code.id, clinId, hours: '8', revisionNumber: 1, createdBy: emp.id, entryDate: '2026-09-02', ...o });

  beforeEach(async () => {
    await cleanupTestData();
    sup = await createTestUser({ role: 'supervisor', fullName: 'Sam Super' });
    emp = await createTestUser({ role: 'employee', fullName: 'Eve Emp' });
    const clin = await createTestClin((await createTestContract()).id);
    clinId = clin.id;
    code = await createTestChargeCode(clin.id);
    await assignUserToClin(sup.id, clin.id);
    await assignUserToClin(emp.id, clin.id);
    session.user = { id: sup.id, role: 'supervisor', email: sup.email, fullName: sup.fullName };
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('corrections, late entries and resubmitted; migration rows and other periods excluded', async () => {
    await entry({ entryDate: '2026-09-02' });
    await entry({ entryDate: '2026-09-02', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'x' });
    await entry({ entryDate: '2026-09-03', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'x' });
    await entry({ entryDate: '2026-09-04', changeReasonCode: 'LATE_ENTRY', comment: 'late' }); // rev 1 + reason = late
    await entry({ entryDate: '2026-09-05', changeReasonCode: 'FORGOT', comment: 'late' });     // any reason on rev 1 = late
    await entry({ entryDate: '2026-09-06', revisionNumber: 3, source: 'migration' });          // imported: excluded
    await entry({ entryDate: '2026-09-07', changeReasonCode: 'LATE_ENTRY', source: 'migration' });
    await entry({ entryDate: '2026-09-20', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'x' }); // next period
    const flags = await periodFlags(db(), [{ id: 'p1', userId: emp.id, periodStart: '2026-09-01' as never, periodNumDays: 15, submissionCount: 2 }]);
    expect(flags.get('p1')).toEqual({ corrections: 2, lateEntries: 2, resubmitted: true });
  });

  it('getScopedPeriods: flags only on rows the user may decide (own and decided rows get null)', async () => {
    await entry({ entryDate: '2026-09-04', changeReasonCode: 'LATE_ENTRY', comment: 'late' });
    await db().insert(schema.timesheetPeriods).values([
      { userId: emp.id, periodStart: '2026-09-01', status: 'submitted', submittedAt: new Date(), periodNumDays: 15, submissionCount: 1 },
      { userId: emp.id, periodStart: '2026-08-16', status: 'approved', submittedAt: new Date(), periodNumDays: 16, submissionCount: 1 },
      { userId: sup.id, periodStart: '2026-09-01', status: 'submitted', submittedAt: new Date(), periodNumDays: 15, submissionCount: 1 },
    ]);
    const rows = await getScopedPeriods();
    const of = (userId: string, start: string) => rows.find((r) => r.userId === userId && r.periodStart === start)!;
    expect(of(emp.id, '2026-09-01')).toMatchObject({ canApprove: true, submissionCount: 1, flags: { corrections: 0, lateEntries: 1, resubmitted: false } });
    expect(of(emp.id, '2026-08-16').flags).toBeNull();
    expect(of(sup.id, '2026-09-01').flags).toBeNull();
  });
});
