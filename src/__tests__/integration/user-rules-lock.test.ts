import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';

/**
 * Certified outputs fix round 1, F1 (CERTIFIED-OUTPUTS-AUDIT.md): the user-rules advisory lock. Deterministic — a raw
 * client R plays one side and holds its locks while the real action runs on its own connection; an observer client
 * waits until the action is either blocked on a lock or finished before R continues.
 *  (a) R holds the user-rules lock + an admin row lock; setUserApprover on a higher-id admin → no 40P01, both complete.
 *  (b) R adds admin3 (and recomputes) while admin2 is deactivated → the log's last row matches the final state.
 *  (c) R demotes a designee while that designee's approval waits on the shared lock → the approval is refused.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const writers = vi.hoisted(() => ({ open: [] as Array<{ end: (o?: { timeout?: number }) => Promise<void> }> }));
vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  // Every write action gets its OWN connection (the shared test client is max: 1 and would serialise everything).
  getDbForWrite: async () => {
    const c = postgres(process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test', { max: 1 });
    writers.open.push(c);
    return drizzle(c, { schema: await import('@/db/schema') });
  },
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000f1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'test-tenant.localhost' }) }));
type FakeSessionUser = { id: string; role: string; email: string; fullName: string };
const sessionState = vi.hoisted(() => ({ user: null as null | FakeSessionUser }));
vi.mock('@/auth', () => ({ auth: async () => (sessionState.user ? { user: { ...sessionState.user, tenantSlug: 'test-tenant' } } : null) }));
vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
}));

import { setUserApprover, updateUser } from '@/server/actions/users';
import { approvePeriod } from '@/server/actions/periods';
import { loadApprovalFacts, lockUserRulesExclusive, recomputeSelfApproval, selfApprovalAvailable } from '@/server/internal/approval-rules';

type U = Awaited<ReturnType<typeof createTestUser>>;
const actingAs = (u: U) => { sessionState.user = { id: u.id, role: u.role, email: u.email, fullName: u.fullName }; };
const observer = postgres(URL, { max: 1 });

/** Resolve once `action` has settled OR some other backend of this database is waiting on a lock. */
async function blockedOrSettled(action: Promise<unknown>, rPid: number): Promise<'blocked' | 'settled'> {
  let settled = false;
  action.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 400; i++) {
    if (settled) return 'settled';
    const [{ n }] = await observer<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> ${rPid} AND pid <> pg_backend_pid()`;
    if (n > 0) return 'blocked';
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('neither blocked nor settled within 10 s');
}

/** A raw client R with one open transaction, driven step by step. */
async function rawTransaction<T>(body: (tx: Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0], pid: number) => Promise<T>): Promise<T> {
  const client = postgres(URL, { max: 1 });
  writers.open.push(client);
  const db = drizzle(client, { schema });
  return db.transaction(async (tx) => {
    const [{ pid }] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Array<{ pid: number }>;
    return body(tx, pid);
  });
}

describe('F1 — user-rules lock (concurrency, real Postgres)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => {
    sessionState.user = null;
    while (writers.open.length) await writers.open.pop()!.end({ timeout: 1 }).catch(() => {});
    await cleanupTestData();
  });
  afterAll(async () => { await observer.end({ timeout: 1 }); });

  it('(a) R holds the lock and the lower admin row; setUserApprover on the higher-id admin waits, no 40P01, both complete', async () => {
    const a = await createTestUser({ role: 'admin', fullName: 'Admin A' });
    const b = await createTestUser({ role: 'admin', fullName: 'Admin B' });
    const [low, high] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    actingAs(low);

    let action!: Promise<Awaited<ReturnType<typeof setUserApprover>>>;
    await rawTransaction(async (tx, pid) => {
      // R plays updateUser after F1: the user-rules lock first, then the admin rows in id order.
      await lockUserRulesExclusive(tx);
      await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, low.id)).for('update');
      // Without F1, setUserApprover would lock `high`, then wait for KEY SHARE on `low` (FK) held by R …
      action = setUserApprover(high.id, low.id);
      await blockedOrSettled(action, pid);
      // … and this would close the cycle (40P01). With F1 the action waits at its first statement instead.
      await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, high.id)).for('update');
    });
    expect(await action).toEqual({ ok: true, data: { approverId: low.id } });
    const [stored] = await getTestDb().select({ approverId: schema.users.approverId }).from(schema.users).where(eq(schema.users.id, high.id));
    expect(stored.approverId).toBe(low.id);
  });

  it('(b) deactivating admin2 while admin3 is being added: the last self_approval row matches the final state', async () => {
    const admin1 = await createTestUser({ role: 'admin', fullName: 'Admin One' });
    const admin2 = await createTestUser({ role: 'admin', fullName: 'Admin Two' });
    actingAs(admin1);

    let action!: Promise<Awaited<ReturnType<typeof updateUser>>>;
    await rawTransaction(async (tx, pid) => {
      // R plays createUser(admin3) after F1: lock, insert, recompute (admin1 still not alone → nothing to log).
      await lockUserRulesExclusive(tx);
      await tx.insert(schema.users).values({ email: `admin3-${Date.now()}@bytime.dev`, fullName: 'Admin Three', role: 'admin', isActive: true });
      await recomputeSelfApproval(tx as never, admin1.id, 'Admin Three added (admin)');
      // Without F1 the deactivation would not wait: it can't see admin3 yet, so it would log admin1 "enabled".
      action = updateUser(admin2.id, { isActive: false });
      await blockedOrSettled(action, pid);
    });
    expect((await action).ok).toBe(true);

    const facts = await loadApprovalFacts(getTestDb());
    const expected = selfApprovalAvailable(facts, admin1.id); // admin1 + admin3 active → false
    expect(expected).toBe(false);
    const [last] = await getTestDb().select().from(schema.adminChangeLog)
      .where(and(eq(schema.adminChangeLog.entity, 'self_approval'), eq(schema.adminChangeLog.entityId, admin1.id)))
      .orderBy(desc(schema.adminChangeLog.createdAt), desc(schema.adminChangeLog.id)).limit(1);
    expect(last?.action === 'enabled').toBe(expected);
  });

  it('(c) a designee demoted while their approval waits on the shared lock → the approval is refused', async () => {
    await createTestUser({ role: 'admin', fullName: 'Owner' });
    const x = await createTestUser({ role: 'supervisor', fullName: 'Sup X' });
    const book = await createTestUser({ role: 'supervisor', fullName: 'Book Keeper' });
    await getTestDb().update(schema.users).set({ approverId: book.id }).where(eq(schema.users.id, x.id));
    const [period] = await getTestDb().insert(schema.timesheetPeriods)
      .values({ userId: x.id, periodStart: '2026-09-01', status: 'submitted', submittedAt: new Date(), submissionCount: 1, periodNumDays: 15 }).returning();
    actingAs(book);

    let action!: Promise<Awaited<ReturnType<typeof approvePeriod>>>;
    await rawTransaction(async (tx, pid) => {
      // R plays updateUser(book → employee) after F1.
      await lockUserRulesExclusive(tx);
      await tx.update(schema.users).set({ role: 'employee' }).where(eq(schema.users.id, book.id));
      // The approval's fail-fast check still sees book as X's designee; it must then wait on the shared lock.
      action = approvePeriod({ periodId: period.id, seen: 1 });
      expect(await blockedOrSettled(action, pid)).toBe('blocked');
    });
    expect(await action).toEqual({ ok: false, code: 'not_found', error: 'Period not found' });
    const [after] = await getTestDb().select({ status: schema.timesheetPeriods.status }).from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, period.id));
    expect(after.status).toBe('submitted');
  });
});
