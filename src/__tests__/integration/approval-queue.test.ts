import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, assignUserToClin, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-navigation-home.md §4.6 / T7 (UX-AUDIT B3): the approver's queue = submitted periods filtered by
 * canApprove (no is_active filter), oldest submission first with null submitted_at last, names once per person;
 * getWaitingCount equals approvalQueue().count.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000a7', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));

import { approvalQueue, getWaitingCount } from '@/server/internal/approval-queue';
import { loadApprovalFacts } from '@/server/internal/approval-rules';

describe('approval queue (T7)', () => {
  const db = () => getTestDb();
  type U = Awaited<ReturnType<typeof createTestUser>>;
  let admin: U; let admin2: U; let sup: U; let peer: U; let emp: U; let emp2: U; let designator: U; let stranger: U; let gone: U;
  const submit = (userId: string, periodStart: string, submittedAt: Date | null, status: 'submitted' | 'approved' = 'submitted') =>
    db().insert(schema.timesheetPeriods).values({ userId, periodStart, status, submittedAt, periodNumDays: 15, submissionCount: 1 });

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    admin2 = await createTestUser({ role: 'admin', fullName: 'Abe Admin' });
    sup = await createTestUser({ role: 'supervisor', fullName: 'Sam Super' });
    peer = await createTestUser({ role: 'supervisor', fullName: 'Pat Peer' });
    emp = await createTestUser({ role: 'employee', fullName: 'Eve Emp' });
    emp2 = await createTestUser({ role: 'employee', fullName: 'Eli Emp' });
    designator = await createTestUser({ role: 'supervisor', fullName: 'Dee Designator', approverId: sup.id });
    stranger = await createTestUser({ role: 'employee', fullName: 'Stu Stranger' });
    gone = await createTestUser({ role: 'employee', fullName: 'Gus Gone' });
    const clin = await createTestClin((await createTestContract()).id);
    for (const u of [sup, peer, emp, emp2, gone, admin]) await assignUserToClin(u.id, clin.id);

    await submit(emp.id, '2026-09-01', new Date('2026-09-17T10:00:00Z'));
    await submit(emp.id, '2026-09-16', new Date('2026-10-02T10:00:00Z'));   // same person twice
    await submit(emp2.id, '2026-09-16', null);                              // null submitted_at → last
    await submit(designator.id, '2026-09-16', new Date('2026-10-01T10:00:00Z'));
    await submit(sup.id, '2026-09-16', new Date('2026-09-30T10:00:00Z'));   // own
    await submit(peer.id, '2026-09-16', new Date('2026-09-30T11:00:00Z'));  // peer supervisor
    await submit(admin.id, '2026-09-16', new Date('2026-09-30T12:00:00Z')); // admin
    await submit(stranger.id, '2026-09-16', new Date('2026-09-30T13:00:00Z')); // no shared CLIN, no designation
    await submit(gone.id, '2026-09-16', new Date('2026-09-20T10:00:00Z'));
    await db().update(schema.users).set({ isActive: false }).where(eq(schema.users.id, gone.id)); // deactivated after submitting
    await submit(emp.id, '2026-08-16', new Date('2026-09-01T10:00:00Z'), 'approved'); // decided → not waiting
  });
  afterEach(async () => { await cleanupTestData(); });

  it('supervisor: excludes own, peer-supervisor, admin and unrelated periods; includes shared-CLIN employees, designators and a deactivated employee', async () => {
    const facts = await loadApprovalFacts(db());
    const q = await approvalQueue(db(), sup.id, facts, { names: 10 });
    expect(q.count).toBe(5); // emp ×2, emp2, designator, gone
    expect(q.names).toEqual(['Eve Emp', 'Gus Gone', 'Dee Designator', 'Eli Emp']); // oldest first, once each, null last
    expect(q.people).toBe(4);
    expect(q.oldestPeriodLabel).toBe('Sep 1 – Sep 15, 2026');
    expect(await getWaitingCount(sup.id)).toBe(q.count);
  });

  it('names are capped by opts.names; "and k more" counts people', async () => {
    const q = await approvalQueue(db(), sup.id, await loadApprovalFacts(db()), { names: 2 });
    expect(q.names).toEqual(['Eve Emp', 'Gus Gone']);
    expect(q.people - q.names.length).toBe(2);
  });

  it('admin: everyone else\'s submitted periods; own only when self-approval is available', async () => {
    let q = await approvalQueue(db(), admin.id, await loadApprovalFacts(db()));
    expect(q.count).toBe(8); // all 9 submitted minus the admin's own (another active admin exists)
    await db().update(schema.users).set({ isActive: false }).where(eq(schema.users.id, admin2.id)); // sole admin, no designee
    q = await approvalQueue(db(), admin.id, await loadApprovalFacts(db()));
    expect(q.count).toBe(9);
  });

  it('nothing waiting → zero, no label', async () => {
    await db().update(schema.timesheetPeriods).set({ status: 'approved' });
    expect(await approvalQueue(db(), sup.id, await loadApprovalFacts(db()))).toEqual({ count: 0, people: 0, names: [], oldestPeriodLabel: null });
  });
});
