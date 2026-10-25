import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-launch-blockers.md P1 §4.2 / §9 "Reset" (the parts that need no database; the concurrency,
 * expiry and sessionVersion scenarios are in src/__tests__/integration/password-reset.test.ts).
 */

const ctx = vi.hoisted(() => ({ slug: 'acme' as string, throwMismatch: false }));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => {
    if (ctx.throwMismatch) throw new Error('Tenant context mismatch — possible header tampering.');
    return ctx.slug;
  },
}));

/** select()…where() resolves to the next queued result; insert()…values() records the row. */
const fake = vi.hoisted(() => {
  const state = { selects: [] as unknown[][], inserted: [] as unknown[] };
  const chain = () => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = () => Promise.resolve(state.selects.shift() ?? []);
    return c;
  };
  const db = {
    select: () => chain(),
    insert: () => ({ values: async (v: unknown) => { state.inserted.push(v); } }),
  };
  return { state, db };
});

const dbAccess = vi.hoisted(() => ({
  getDb: vi.fn(async () => { throw new Error('This workspace is suspended.'); }), // billing_only: getDb refuses
  getDbForAuth: vi.fn(async () => fake.db),
}));
vi.mock('@/db', () => dbAccess);

const afterTasks = vi.hoisted(() => [] as Array<() => Promise<unknown>>);
vi.mock('next/server', () => ({ after: (fn: () => Promise<unknown>) => { afterTasks.push(fn); } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const sendReset = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, id: 'msg' })));
vi.mock('@/lib/email/send', () => ({ sendPasswordResetEmail: sendReset }));

import { requestPasswordReset, verifyResetToken } from '@/server/actions/password-reset';
import { tenantBaseUrl } from '@/lib/tenant/host';

beforeEach(() => {
  ctx.slug = 'acme';
  ctx.throwMismatch = false;
  fake.state.selects = [];
  fake.state.inserted = [];
  afterTasks.length = 0;
  sendReset.mockClear();
  dbAccess.getDbForAuth.mockClear();
});

describe('requestPasswordReset', () => {
  it('on a workspace host, emails a link to THAT workspace host, scheduled with after()', async () => {
    fake.state.selects = [[], [{ id: 'u1', fullName: 'Jane' }]]; // no recent requests; active user found
    await expect(requestPasswordReset('jane@acme.com')).resolves.toEqual({ ok: true, data: undefined });

    expect(fake.state.inserted).toHaveLength(1);
    expect(sendReset).not.toHaveBeenCalled(); // not sent inline
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]();
    expect(sendReset).toHaveBeenCalledTimes(1);
    const arg = (sendReset.mock.calls[0] as unknown as [{ resetUrl: string; appUrl: string }])[0];
    expect(arg.appUrl).toBe(tenantBaseUrl('acme'));
    expect(arg.resetUrl.startsWith(`${tenantBaseUrl('acme')}/reset-password?token=`)).toBe(true);
  });

  it('a failed send ({ ok: false }) never affects the action’s result', async () => {
    sendReset.mockResolvedValueOnce({ ok: false, reason: 'error' } as never);
    fake.state.selects = [[], [{ id: 'u1', fullName: 'Jane' }]];
    await expect(requestPasswordReset('jane@acme.com')).resolves.toEqual({ ok: true, data: undefined });
    await expect(afterTasks[0]()).resolves.toBeUndefined();
  });

  it('on the apex (no tenant), returns the generic success and sends nothing', async () => {
    ctx.slug = '';
    await expect(requestPasswordReset('jane@acme.com')).resolves.toEqual({ ok: true, data: undefined });
    expect(dbAccess.getDbForAuth).not.toHaveBeenCalled();
    expect(fake.state.inserted).toHaveLength(0);
    expect(afterTasks).toHaveLength(0);
  });

  it('a host/header mismatch is treated like no tenant: generic success, nothing sent', async () => {
    ctx.throwMismatch = true;
    await expect(requestPasswordReset('jane@acme.com')).resolves.toEqual({ ok: true, data: undefined });
    expect(afterTasks).toHaveLength(0);
  });
});

describe('verifyResetToken', () => {
  // Audit A9: the pre-check must answer before any database is resolved (a fake db would otherwise hide its removal).
  it('on the apex returns { valid: false } instead of throwing — without touching the database', async () => {
    ctx.slug = '';
    await expect(verifyResetToken('jane@acme.com', 'tok')).resolves.toEqual({ valid: false });
    expect(dbAccess.getDbForAuth).not.toHaveBeenCalled();
  });

  it('a host/header mismatch returns { valid: false } instead of throwing — without touching the database', async () => {
    ctx.throwMismatch = true;
    await expect(verifyResetToken('jane@acme.com', 'tok')).resolves.toEqual({ valid: false });
    expect(dbAccess.getDbForAuth).not.toHaveBeenCalled();
  });

  it('uses getDbForAuth, so a billing_only workspace’s admin can verify (getDb would refuse)', async () => {
    fake.state.selects = [[{ id: 't1', expiresAt: new Date(Date.now() + 60_000) }]];
    await expect(verifyResetToken('admin@acme.com', 'tok')).resolves.toEqual({ valid: true });
    expect(dbAccess.getDbForAuth).toHaveBeenCalled();
    expect(dbAccess.getDb).not.toHaveBeenCalled();
  });

  it('an expired token is invalid', async () => {
    fake.state.selects = [[{ id: 't1', expiresAt: new Date(Date.now() - 1000) }]];
    await expect(verifyResetToken('admin@acme.com', 'tok')).resolves.toEqual({ valid: false });
  });
});
