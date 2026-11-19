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
  // `wheres`: every select's condition, in order (render with drizzle's PgDialect). `updates`: each update's set and
  // condition; `returnings` scripts their `.returning()` results (SWEEP-FINDINGS.md A1-G16).
  const state = {
    selects: [] as unknown[][], inserted: [] as unknown[], wheres: [] as unknown[],
    updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>, returnings: [] as unknown[][],
  };
  const chain = () => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = (w: unknown) => { state.wheres.push(w); return Promise.resolve(state.selects.shift() ?? []); };
    return c;
  };
  const update = () => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        state.updates.push({ set, where });
        return { returning: async () => state.returnings.shift() ?? [] };
      },
    }),
  });
  const db = {
    select: () => chain(),
    insert: () => ({ values: async (v: unknown) => { state.inserted.push(v); } }),
    update,
    transaction: async (cb: (tx: unknown) => unknown) => cb({ update }),
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
// The per-IP reset limit (feature-plan-upstash-rate-limiting.md Q3) reads the client IP from the request headers.
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.20' }) }));

const sendReset = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, id: 'msg' })));
vi.mock('@/lib/email/send', () => ({ sendPasswordResetEmail: sendReset }));

import { requestPasswordReset, resetPassword, verifyResetToken } from '@/server/actions/password-reset';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { tenantBaseUrl } from '@/lib/tenant/host';

beforeEach(() => {
  ctx.slug = 'acme';
  ctx.throwMismatch = false;
  fake.state.selects = [];
  fake.state.inserted = [];
  fake.state.wheres = [];
  fake.state.updates = [];
  fake.state.returnings = [];
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

const render = (w: unknown) => new PgDialect().sqlToQuery(w as SQL);

describe('A1-G16: the per-email limit, active users only, single use, the password rule (A1-D8)', () => {
  it('3 requests for the email in the last hour → generic success, no user lookup, no token; 2 → a token', async () => {
    fake.state.selects = [[{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]];
    await expect(requestPasswordReset('Jane@Acme.com ')).resolves.toEqual({ ok: true, data: undefined });
    expect(fake.state.inserted).toEqual([]);
    expect(fake.state.wheres).toHaveLength(1); // the count only: the user is never looked up
    const q = render(fake.state.wheres[0]);
    expect(q.sql).toMatch(/"password_reset_tokens"\."email" = \$1 and "password_reset_tokens"\."created_at" >= \$2/);
    expect(q.params[0]).toBe('jane@acme.com');
    expect(Date.now() - new Date(q.params[1] as string).getTime()).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(Date.now() - new Date(q.params[1] as string).getTime()).toBeLessThanOrEqual(3_600_000 + 5_000);

    fake.state.wheres = [];
    fake.state.selects = [[{ id: 'r1' }, { id: 'r2' }], [{ id: 'u1', fullName: 'Jane' }]];
    await requestPasswordReset('jane@acme.com');
    expect(fake.state.inserted).toHaveLength(1);
  });

  it('the user lookup takes active users only (an inactive one gets no token)', async () => {
    fake.state.selects = [[], []]; // the database returns no ACTIVE user with this email
    await requestPasswordReset('jane@acme.com');
    expect(fake.state.inserted).toEqual([]);
    const q = render(fake.state.wheres[1]);
    expect(q.sql).toMatch(/"users"\."email" = \$1 and "users"\."is_active" = \$2/);
    expect(q.params).toEqual(['jane@acme.com', true]);
  });

  it('a reset claims the token once (used_at set only where it is still null and unexpired) and bumps the session', async () => {
    fake.state.selects = [[{ id: 'tok-1' }]];            // the pre-check finds the token
    fake.state.returnings = [[{ id: 'tok-1' }], [{ id: 'u1' }]];
    await expect(resetPassword({ email: 'jane@acme.com', token: 'raw', newPassword: 'brand-new-pass' })).resolves.toEqual({ ok: true, data: undefined });
    const [claim, user] = fake.state.updates;
    expect(claim.set.usedAt).toBeInstanceOf(Date);
    expect(render(claim.where).sql).toMatch(/"password_reset_tokens"\."id" = \$1 and "password_reset_tokens"\."used_at" is null and "password_reset_tokens"\."expires_at" > \$2/);
    expect(render(user.set.sessionVersion).sql).toMatch(/"session_version" \+ 1/);

    fake.state.updates = [];
    fake.state.selects = [[{ id: 'tok-1' }]];
    fake.state.returnings = [[]];                          // already claimed by a concurrent request
    await expect(resetPassword({ email: 'jane@acme.com', token: 'raw', newPassword: 'brand-new-pass' }))
      .resolves.toEqual({ ok: false, error: 'Invalid or expired reset link. Please request a new one.', code: 'validation' });
    expect(fake.state.updates).toHaveLength(1);           // no password written
  });

  it.each([
    ['7 characters', 'short12'],
    ['a number (A1-D8)', 12345678],
    ['a 9-element array (A1-D8)', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']],
    ['missing (A1-D8)', undefined],
  ])('a new password that is %s → the minimum-length message, no token lookup', async (_label, newPassword) => {
    fake.state.selects = [[{ id: 'tok-1' }]];
    await expect(resetPassword({ email: 'jane@acme.com', token: 'raw', newPassword: newPassword as string }))
      .resolves.toEqual({ ok: false, error: 'Password must be at least 8 characters.', code: 'validation' });
    expect(fake.state.wheres).toEqual([]);
    expect(fake.state.updates).toEqual([]);
  });

  it('129 characters → the maximum-length message', async () => {
    await expect(resetPassword({ email: 'jane@acme.com', token: 'raw', newPassword: 'x'.repeat(129) }))
      .resolves.toMatchObject({ ok: false, error: 'Password must not exceed 128 characters.' });
  });
});
