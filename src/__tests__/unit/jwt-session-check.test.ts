import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A1-G2: jwtCallback's slow path (src/auth.ts) — the check that ends a session when the user is
 * deactivated, deleted or has had their sessionVersion bumped (role change, password change, admin reset), and keeps
 * the role and name in sync. It runs at most once per 60 s per token. The session callback turns an invalidated token
 * into a session without a user. Tenant binding and closed workspaces are covered by tenant-bound-jwt and
 * tenant-closed-jwt; here the workspace is a normal full one and only the users row varies.
 */

const h = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  queries: 0,
  dbUrls: [] as string[],
  config: null as null | { callbacks: { session: (a: { session: Record<string, unknown>; token: Record<string, unknown> }) => Promise<Record<string, unknown>> } },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/auth', async (importOriginal) => importOriginal()); // the REAL module (setup.ts mocks it globally)
vi.mock('next-auth', () => ({
  default: (config: never) => { h.config = config; return { handlers: {}, auth: async () => null, signIn: async () => undefined, signOut: async () => undefined }; },
}));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'acme' }));
vi.mock('@/lib/tenant/registry', () => ({
  getTenantBySlug: async () => ({
    id: 't', slug: 'acme', name: 'Acme', plan: 'standard', dbUrl: 'postgresql://app@db/acme', neonProjectId: null,
    stripeCustomerId: null, stripeCustomerDeletedAt: null, currentPeriodEnd: null, lifecycleVersion: 0,
    status: 'active', subscriptionStatus: 'active', stripeSubscriptionId: 'sub_1', trialEndsAt: null, pastDueSince: null,
    suspendedAt: null, suspensionReason: null, subscriptionEndedAt: null, deletionScheduledFor: null, firstGoodAt: new Date(),
    lifecycleExempt: false, policyExportAllowed: false, collectionMethod: null,
  }),
  invalidateTenant: () => {},
}));
vi.mock('@/db', () => {
  const db = { select: () => ({ from: () => ({ where: () => { h.queries++; return Promise.resolve(h.row ? [h.row] : []); } }) }) };
  return { getDbForUrl: (url: string) => { h.dbUrls.push(url); return db; }, getDbForAuth: async () => db, getDb: async () => db };
});

import { jwtCallback } from '@/auth';

const NOW = Date.now();
const token = (o: Record<string, unknown> = {}) =>
  ({ id: 'user-1', role: 'admin', fullName: 'Ann Admin', tenantSlug: 'acme', sessionVersion: 3, lastSessionCheck: NOW - 61_000, ...o }) as never;
const live = (o: Record<string, unknown> = {}) => ({ sessionVersion: 3, isActive: true, role: 'admin', fullName: 'Ann Admin', ...o });

beforeEach(() => {
  h.row = live();
  h.queries = 0;
  h.dbUrls = [];
});

describe('A1-G2: the slow-path session check (once the 60 s fast path has expired)', () => {
  it('an active user with the same sessionVersion keeps the session (control)', async () => {
    const out = (await jwtCallback({ token: token() })) as Record<string, unknown>;
    expect(out.invalidated).toBeUndefined();
    expect(h.queries).toBe(1);
    expect(h.dbUrls).toEqual(['postgresql://app@db/acme']);
  });

  it('a deactivated user → invalidated', async () => {
    h.row = live({ isActive: false });
    expect(await jwtCallback({ token: token() })).toMatchObject({ invalidated: true });
  });

  it('a sessionVersion bump (role change, password change, admin reset) → invalidated', async () => {
    h.row = live({ sessionVersion: 4 });
    expect(await jwtCallback({ token: token() })).toMatchObject({ invalidated: true });
  });

  it('a token with no sessionVersion counts as version 1', async () => {
    h.row = live({ sessionVersion: 1 });
    expect((await jwtCallback({ token: token({ sessionVersion: undefined }) }) as Record<string, unknown>).invalidated).toBeUndefined();
    h.row = live({ sessionVersion: 2 });
    expect(await jwtCallback({ token: token({ sessionVersion: undefined }) })).toMatchObject({ invalidated: true });
  });

  it('a deleted user (no row) → invalidated', async () => {
    h.row = null;
    expect(await jwtCallback({ token: token() })).toMatchObject({ invalidated: true });
  });

  it('the role and name are re-synced from the database, and the check time is recorded', async () => {
    h.row = live({ role: 'supervisor', fullName: 'Ann B. Admin' });
    const before = Date.now();
    const out = (await jwtCallback({ token: token() })) as Record<string, unknown>;
    expect(out).toMatchObject({ role: 'supervisor', fullName: 'Ann B. Admin' });
    expect(out.invalidated).toBeUndefined();
    expect(out.lastSessionCheck as number).toBeGreaterThanOrEqual(before);
  });
});

describe('A1-G2: the 60-second fast path', () => {
  it('checked 59 s ago → no query, token unchanged even if the user was deactivated since', async () => {
    h.row = live({ isActive: false });
    const t = token({ lastSessionCheck: Date.now() - 59_000 });
    expect(await jwtCallback({ token: t })).toBe(t);
    expect(h.queries).toBe(0);
  });

  it('checked just over 60 s ago → queried (and the deactivation found)', async () => {
    h.row = live({ isActive: false });
    expect(await jwtCallback({ token: token({ lastSessionCheck: Date.now() - 60_500 }) })).toMatchObject({ invalidated: true });
    expect(h.queries).toBe(1);
  });

  it('a fresh check followed by a call within the minute runs exactly one query', async () => {
    const first = await jwtCallback({ token: token() });
    await jwtCallback({ token: first as never });
    expect(h.queries).toBe(1);
  });
});

describe('A1-G2: the session callback', () => {
  const session = () => ({ user: { name: 'x', email: 'ann@acme.test' }, expires: '2099-01-01' });

  it('an invalidated token → the session has no user', async () => {
    const out = await h.config!.callbacks.session({ session: session(), token: { id: 'user-1', role: 'admin', invalidated: true } });
    expect(out.user).toBeUndefined();
  });

  it('a valid token → id, role, name and workspace are copied onto the user', async () => {
    const out = await h.config!.callbacks.session({ session: session(), token: { id: 'user-1', role: 'supervisor', fullName: 'Ann', tenantSlug: 'acme' } });
    expect(out.user).toMatchObject({ id: 'user-1', role: 'supervisor', fullName: 'Ann', tenantSlug: 'acme' });
  });
});
