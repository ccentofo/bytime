import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md §4 (session S1): the tenant gates, with the REAL `@/lib/tenant/context`, the real lifecycle rules
 * (getTenantAccess) and the real `@/db`. Only the request headers, the registry and the postgres.js constructor are fakes.
 * A1-G1 / A2-G1  the write gate: getTenantForWrite resolves only in `full` and throws WorkspaceReadOnlyError with the
 *                exact message for read_only, billing_only, policy_hold, closed, deleting and provisioning; getDbForWrite
 *                goes through it.
 * A1-G5          one pool per connection string.
 * A1-G7 / A2-G9  getDbForAuth refuses a closed workspace (and allows read_only and billing_only).
 * A1-G8          getTenantState with a forged x-tenant-slug → mismatch.
 * A1-G22         getTenantForBilling refuses deleting and deleted workspaces.
 */

const h = vi.hoisted(() => ({
  host: null as string | null,
  injected: null as string | null,
  record: null as null | Record<string, unknown>,
  lookups: [] as string[],
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => {
    const m = new Headers();
    if (h.host) m.set('host', h.host);
    if (h.injected) m.set('x-tenant-slug', h.injected);
    return m;
  },
}));
vi.mock('@/lib/tenant/registry', () => ({
  getTenantBySlug: async (slug: string) => { h.lookups.push(slug); return h.record; },
  invalidateTenant: () => {},
}));
const postgresSpy = vi.hoisted(() => vi.fn((url: string) => ({ __url: url, options: { parsers: {}, serializers: {} } })));
vi.mock('postgres', () => ({ default: postgresSpy }));
vi.mock('@/db', async (importOriginal) => importOriginal()); // the REAL module (setup.ts mocks it globally)

import { getDbForAuth, getDbForUrl, getDbForWrite } from '@/db';
import { getTenantForBilling, getTenantForWrite, getTenantState, WorkspaceReadOnlyError } from '@/lib/tenant/context';
import { rootDomain } from '@/lib/tenant/host';

const ACME_HOST = `acme.${rootDomain()}:3000`;

/**
 * The URL a client was built for (drizzle keeps the postgres.js client as `$client`; the fake records its URL). Every
 * pool assertion compares these small strings or a boolean, never the drizzle objects themselves: a failing
 * `toBe(drizzleInstance)` makes vitest format the whole schema graph and the worker runs out of memory (lead's audit:
 * the shared-pool mutation crashed the file instead of failing the G5 assertion).
 */
const urlOf = (db: unknown) => (db as { $client: { __url: string } }).$client.__url;

const DAY = 86_400_000;
const URL_A = 'postgresql://app@db-a.internal/acme';
function record(o: Record<string, unknown> = {}) {
  return {
    id: 't1', slug: 'acme', name: 'Acme', plan: 'standard', dbUrl: URL_A, neonProjectId: null,
    stripeCustomerId: null, stripeCustomerDeletedAt: null, currentPeriodEnd: null, lifecycleVersion: 0,
    status: 'active', subscriptionStatus: null, stripeSubscriptionId: null, trialEndsAt: new Date(Date.now() + 10 * DAY),
    pastDueSince: null, suspendedAt: null, suspensionReason: null, subscriptionEndedAt: null, deletionScheduledFor: null,
    firstGoodAt: null, lifecycleExempt: false, policyExportAllowed: false, collectionMethod: null, ...o,
  };
}
/** One record per access mode (lifecycle.ts getTenantAccess). */
const MODES = {
  full: record(),
  read_only: record({ trialEndsAt: new Date(Date.now() - DAY) }),
  billing_only: record({ status: 'suspended', suspensionReason: 'nonpayment', suspendedAt: new Date(Date.now() - DAY) }),
  policy_hold: record({ status: 'suspended', suspensionReason: 'policy', suspendedAt: new Date(Date.now() - DAY) }),
  closed: record({ trialEndsAt: new Date(Date.now() - 200 * DAY), deletionScheduledFor: new Date(Date.now() - DAY) }),
  deleting: record({ status: 'deleting' }),
  deleted: record({ status: 'deleted', dbUrl: '' }),
  provisioning: record({ status: 'provisioning' }),
};

beforeEach(() => {
  h.host = ACME_HOST;
  h.injected = null;
  h.record = MODES.full;
  h.lookups = [];
});

async function refusal(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('expected a refusal, but it resolved');
}

describe('A1-G1: the write gate (getTenantForWrite)', () => {
  it('full → resolves with the request tenant', async () => {
    await expect(getTenantForWrite()).resolves.toMatchObject({ slug: 'acme', dbUrl: URL_A });
    expect(h.lookups).toEqual(['acme']);
  });

  it.each([
    ['read_only', 'This workspace is read-only. Subscribe to make changes.'],
    ['billing_only', 'This workspace is suspended. Update billing to restore access.'],
    ['policy_hold', 'This workspace is on hold. Contact support@cadenzpoint.com.'],
    ['closed', 'This workspace is not available.'],
    ['deleting', 'This workspace is not available.'],
    ['deleted', 'This workspace is not available.'],
    ['provisioning', 'This workspace is still being set up. Please try again shortly.'],
  ] as const)('%s → WorkspaceReadOnlyError: "%s"', async (mode, message) => {
    h.record = MODES[mode];
    const err = await refusal(getTenantForWrite());
    expect(err).toBeInstanceOf(WorkspaceReadOnlyError);
    expect(err.message).toBe(message);
  });

  it('no workspace on the host, or an unknown one → refused (not a write client)', async () => {
    h.host = `${rootDomain()}:3000`;
    await expect(getTenantForWrite()).rejects.toThrow('No tenant in request context.');
    h.host = ACME_HOST;
    h.record = null;
    await expect(getTenantForWrite()).rejects.toThrow('Unknown workspace: acme');
  });
});

describe('A1-G1: getDbForWrite goes through the write gate', () => {
  it('full → the pooled client for the tenant URL', async () => {
    const db = await getDbForWrite();
    expect(urlOf(db)).toBe(URL_A);
    expect(db === getDbForUrl(URL_A), 'the pooled client').toBe(true);
  });

  it.each(['read_only', 'billing_only', 'policy_hold', 'closed', 'provisioning'] as const)('%s → WorkspaceReadOnlyError, no client constructed', async (mode) => {
    h.record = MODES[mode];
    postgresSpy.mockClear();
    const err = await refusal(getDbForWrite());
    expect(err).toBeInstanceOf(WorkspaceReadOnlyError);
    expect(postgresSpy).not.toHaveBeenCalled();
  });
});

describe('A1-G5: one pool per connection string', () => {
  it('the same URL → the same client (constructed once); another URL → another client', () => {
    const a = 'postgresql://app@pool-a.internal/one';
    const b = 'postgresql://app@pool-b.internal/two';
    postgresSpy.mockClear();
    const a1 = getDbForUrl(a);
    expect(urlOf(a1)).toBe(a);
    expect(getDbForUrl(a) === a1, 'the same URL reuses its client').toBe(true);
    const b1 = getDbForUrl(b);
    expect(urlOf(b1)).toBe(b);                                        // not a's pool
    expect(b1 === a1, 'another URL gets another client').toBe(false);
    expect(postgresSpy.mock.calls.map((c) => c[0])).toEqual([a, b]);
    expect(getDbForUrl(b) === b1, 'and reuses it').toBe(true);
    expect(postgresSpy).toHaveBeenCalledTimes(2);
  });
});

describe('A1-G7: getDbForAuth refuses only a closed workspace', () => {
  it.each(['closed', 'deleting', 'deleted', 'provisioning'] as const)('%s → "This workspace is not available."', async (mode) => {
    h.record = MODES[mode];
    await expect(getDbForAuth()).rejects.toThrow('This workspace is not available.');
  });

  it.each(['full', 'read_only', 'billing_only', 'policy_hold'] as const)('%s → the tenant client (sign-in and account security keep working)', async (mode) => {
    h.record = MODES[mode];
    const db = await getDbForAuth();
    expect(urlOf(db)).toBe(URL_A);
    expect(db === getDbForUrl(URL_A), 'the pooled client').toBe(true);
  });
});

describe('A1-G8: getTenantState with a forged header', () => {
  it('x-tenant-slug disagreeing with the host → mismatch, and the registry is never asked', async () => {
    h.injected = 'globex';
    await expect(getTenantState()).resolves.toEqual({ kind: 'mismatch' });
    expect(h.lookups).toEqual([]);
  });

  it('an agreeing header → the tenant state as usual', async () => {
    h.injected = 'acme';
    await expect(getTenantState()).resolves.toMatchObject({ kind: 'full', tenant: { slug: 'acme' } });
  });
});

describe('A1-G22: getTenantForBilling refuses deleting and deleted workspaces', () => {
  it('deleting → "This workspace is being removed."; deleted → "This workspace is not available."', async () => {
    h.record = MODES.deleting;
    await expect(getTenantForBilling()).rejects.toThrow('This workspace is being removed.');
    h.record = MODES.deleted;
    await expect(getTenantForBilling()).rejects.toThrow('This workspace is not available.');
  });

  it('active and suspended-for-nonpayment still reach billing', async () => {
    h.record = MODES.full;
    await expect(getTenantForBilling()).resolves.toMatchObject({ slug: 'acme' });
    h.record = MODES.billing_only;
    await expect(getTenantForBilling()).resolves.toMatchObject({ status: 'suspended' });
  });
});
