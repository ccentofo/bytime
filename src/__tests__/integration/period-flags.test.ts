import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, assignUserToClin, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-navigation-home.md §4.6 / T13, revised by feature-plan-ux-approvals-payroll.md A4 / A-2: "Worth a
 * look" counts CELLS — a correction is a cell whose latest app revision is > 1 (rev 2 and rev 3 → one); a late entry
 * is a cell whose revision 1 has a reason and that was never revised (a late cell later corrected is a correction);
 * resubmitted = submission_count > 1. Imported (source = 'migration') rows are never flags but their hours count;
 * hours = the latest-revision sum (the varchar cast). Flags only on rows the session user may decide.
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

  it('A-2: per cell — rev 2 + rev 3 is one correction; late-then-corrected is a correction; imported hours count but never flag', async () => {
    const code2 = await createTestChargeCode(clinId);
    await entry({ entryDate: '2026-09-02', hours: '8.00' });
    await entry({ entryDate: '2026-09-02', hours: '6.00', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'x' });
    await entry({ entryDate: '2026-09-02', hours: '5.00', revisionNumber: 3, changeReasonCode: 'CORRECTION', comment: 'y' });  // one cell → 1
    await entry({ entryDate: '2026-09-02', chargeCodeId: code2.id, hours: '1.00' });
    await entry({ entryDate: '2026-09-02', chargeCodeId: code2.id, hours: '2.00', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'z' }); // same day, other cell → 1
    await entry({ entryDate: '2026-09-03', hours: '4.00', changeReasonCode: 'LATE_ENTRY', comment: 'late' });
    await entry({ entryDate: '2026-09-03', hours: '3.00', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'fix' }); // late, then corrected → correction
    await entry({ entryDate: '2026-09-04', hours: '2.00', changeReasonCode: 'LATE_ENTRY', comment: 'late' });                     // late
    await entry({ entryDate: '2026-09-05', hours: '7.50', changeReasonCode: 'FORGOT', comment: 'late' });                         // any reason on rev 1 = late
    await entry({ entryDate: '2026-09-06', hours: '1.25', revisionNumber: 3, source: 'migration' });                              // imported: hours only
    await entry({ entryDate: '2026-09-07', hours: '0.75', changeReasonCode: 'LATE_ENTRY', source: 'migration' });                 // imported: hours only
    await entry({ entryDate: '2026-09-08', hours: '8.00' });
    await entry({ entryDate: '2026-09-20', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'x' });                    // next period
    const flags = await periodFlags(db(), [{ id: 'p1', userId: emp.id, periodStart: '2026-09-01' as never, periodNumDays: 15, submissionCount: 2 }]);
    expect(flags.get('p1')).toEqual({ corrections: 3, lateEntries: 2, resubmitted: true, hours: 29.5 });
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
    expect(of(emp.id, '2026-09-01')).toMatchObject({ canApprove: true, submissionCount: 1, flags: { corrections: 0, lateEntries: 1, resubmitted: false, hours: 8 } });
    expect(of(emp.id, '2026-08-16').flags).toBeNull();
    expect(of(sup.id, '2026-09-01').flags).toBeNull();
  });
});
