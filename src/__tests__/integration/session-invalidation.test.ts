import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import type { JWT } from '@auth/core/jwt';
import { getTestDb, createTestUser, cleanupTestData, expectOk } from './helpers';

/**
 * Session invalidation, end to end against Postgres (SWEEP-FINDINGS.md A1-G2; repaired by the lead's decision: this file
 * used to write `sessionVersion + 1` itself and read it back, which proved nothing). The REAL writers — changePassword,
 * and updateUser with a role-only and an active-only change — run against the database, then the REAL jwtCallback reads
 * the same row and must invalidate the session issued before the change. A name-only edit must not. The sign-in token
 * comes from jwtCallback's own sign-in branch, so the sessionVersion it carries is the one the database held then.
 * Only the request layer is faked: the tenant (pointing at the test database), the session the actions read, and the
 * workspace's seat bookkeeping.
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()), // getDbForUrl stays real: jwtCallback opens the test database by URL
  getDb: async () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: 'test-tenant-id', slug: 'test-tenant', name: 'Test Tenant', status: 'active', plan: 'enterprise', dbUrl: TEST_DB_URL }),
}));
vi.mock('@/lib/tenant/registry', () => ({
  getTenantBySlug: async (slug: string) => slug === 'test-tenant'
    ? {
        id: 'test-tenant-id', slug: 'test-tenant', name: 'Test Tenant', status: 'active', plan: 'enterprise', dbUrl: TEST_DB_URL,
        subscriptionStatus: 'active', stripeSubscriptionId: 'sub_test', trialEndsAt: null, pastDueSince: null, suspendedAt: null,
        suspensionReason: null, subscriptionEndedAt: null, deletionScheduledFor: null, firstGoodAt: new Date(), lifecycleExempt: false,
        policyExportAllowed: false, stripeCustomerId: null, stripeCustomerDeletedAt: null, currentPeriodEnd: null,
        neonProjectId: null, lifecycleVersion: 0, collectionMethod: null,
      }
    : null,
  invalidateTenant: () => {},
}));
vi.mock('@/server/internal/plan-source', () => ({ readPlanFresh: async () => 'enterprise' }));
vi.mock('@/lib/billing/seat-sync', () => ({ markSeatSyncDue: vi.fn(async () => {}) }));

const sessionState = vi.hoisted(() => ({ user: null as null | { id: string; role: string; email: string; fullName: string } }));
vi.mock('@/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/auth')>()), // the REAL jwtCallback
  auth: async () => (sessionState.user ? { user: { ...sessionState.user, tenantSlug: 'test-tenant' } } : null),
}));

import { jwtCallback } from '@/auth';
import { changePassword } from '@/server/actions/password';
import { updateUser } from '@/server/actions/users';

type U = Awaited<ReturnType<typeof createTestUser>>;
const actingAs = (u: U) => { sessionState.user = { id: u.id, role: u.role, email: u.email, fullName: u.fullName }; };

/** The token jwtCallback issues at sign-in (its sign-in branch reads sessionVersion from the database). */
async function signIn(u: U): Promise<JWT> {
  return (await jwtCallback({ token: {} as JWT, user: { id: u.id, role: u.role, name: u.fullName } })) as JWT;
}
/** A later request, after the 60-second fast path has run out. */
async function laterRequest(token: JWT): Promise<JWT & { invalidated?: boolean }> {
  return (await jwtCallback({ token: { ...token, lastSessionCheck: Date.now() - 61_000 } })) as JWT & { invalidated?: boolean };
}

describe('Session invalidation through the real writers and the real jwtCallback', () => {
  let admin: U;
  let pat: U;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    pat = await createTestUser({ role: 'employee', fullName: 'Pat', passwordHash: await bcrypt.hash('OldPassword123!', 4), sessionVersion: 3 });
  });
  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('the sign-in token carries the database sessionVersion, and an unchanged user keeps the session (control)', async () => {
    const token = await signIn(pat);
    expect(token).toMatchObject({ id: pat.id, tenantSlug: 'test-tenant', sessionVersion: 3 });
    const later = await laterRequest(token);
    expect(later.invalidated).toBeUndefined();
    expect(later.role).toBe('employee');
  });

  it('changePassword ends the sessions issued before it', async () => {
    const token = await signIn(pat);
    actingAs(pat);
    await expectOk(changePassword({ currentPassword: 'OldPassword123!', newPassword: 'NewPassword456!' }));
    expect(await laterRequest(token)).toMatchObject({ invalidated: true });
    // A session issued after the change is valid.
    expect((await laterRequest(await signIn(pat))).invalidated).toBeUndefined();
  });

  it('updateUser with a role-only change (employee → admin) ends the target\'s sessions', async () => {
    const token = await signIn(pat);
    actingAs(admin);
    await expectOk(updateUser(pat.id, { role: 'admin' }));
    expect(await laterRequest(token)).toMatchObject({ invalidated: true });
  });

  it('updateUser with an active-only change (deactivate) ends the target\'s sessions', async () => {
    const token = await signIn(pat);
    actingAs(admin);
    await expectOk(updateUser(pat.id, { isActive: false }));
    expect(await laterRequest(token)).toMatchObject({ invalidated: true });
  });

  it('a name-only edit keeps the session, and the new name is synced into the token', async () => {
    const token = await signIn(pat);
    actingAs(admin);
    await expectOk(updateUser(pat.id, { fullName: 'Pat Renamed' }));
    const later = await laterRequest(token);
    expect(later.invalidated).toBeUndefined();
    expect(later.fullName).toBe('Pat Renamed');
  });
});
