import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-terms-compliance-fixes.md §5.6: after the tenant-binding check, jwtCallback reads the workspace's
 * access mode from the cached registry record. A workspace being deleted (or deleted) ends every session; any other
 * closed mode skips the tenant-DB check (its database may be gone or unreachable by design).
 */

const state = vi.hoisted(() => ({ record: null as null | Record<string, unknown> }));
const dbForUrl = vi.hoisted(() => vi.fn(() => { throw new Error('tenant DB must not be touched'); }));

vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: vi.fn(async () => 'tenant-a') }));
vi.mock('@/lib/tenant/registry', () => ({
  getTenantBySlug: vi.fn(async () => state.record),
  invalidateTenant: vi.fn(),
}));
vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDbForUrl: dbForUrl,
}));

import { jwtCallback } from '@/auth';

const DAY = 86_400_000;
function record(o: Record<string, unknown>) {
  return {
    id: 't', slug: 'tenant-a', name: 'A', plan: 'trial', dbUrl: 'postgresql://x@localhost/x', neonProjectId: null,
    stripeCustomerId: null, stripeCustomerDeletedAt: null, currentPeriodEnd: null, lifecycleVersion: 0,
    status: 'active', subscriptionStatus: null, stripeSubscriptionId: null, trialEndsAt: new Date(Date.now() + 10 * DAY),
    pastDueSince: null, suspendedAt: null, suspensionReason: null, subscriptionEndedAt: null, deletionScheduledFor: null,
    firstGoodAt: null, lifecycleExempt: false, ...o,
  };
}
const token = () => ({ id: 'user-1', role: 'admin', tenantSlug: 'tenant-a', sessionVersion: 1 } as never);

describe('jwtCallback and closed workspaces (§5.6)', () => {
  beforeEach(() => { dbForUrl.mockClear(); }); // braces: a returned function would run as a teardown

  it.each([['deleting'], ['deleted']])('a %s workspace ends the session (null)', async (status) => {
    state.record = record({ status, dbUrl: status === 'deleted' ? '' : 'postgresql://x@localhost/x' });
    expect(await jwtCallback({ token: token() })).toBeNull();
    expect(dbForUrl).not.toHaveBeenCalled();
  });

  it('a workspace past its deletion date (closed) skips the tenant-DB check and keeps the token', async () => {
    state.record = record({ trialEndsAt: new Date(Date.now() - 200 * DAY), deletionScheduledFor: new Date(Date.now() - DAY) });
    const t = token();
    expect(await jwtCallback({ token: t })).toBe(t);
    expect(dbForUrl).not.toHaveBeenCalled();
  });

  it('a full workspace still runs the tenant-DB session check (slow path)', async () => {
    state.record = record({});
    await jwtCallback({ token: token() });
    expect(dbForUrl).toHaveBeenCalledTimes(1); // fails open on the thrown error, but the check was attempted
  });
});
