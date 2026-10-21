import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// R2-1: cross-tenant session replay. One Auth.js instance and one AUTH_SECRET serve
// every tenant; a JWT signed for tenant A verifies perfectly well on a request to
// tenant B's host. jwtCallback must re-bind the token to the REQUEST's tenant on
// every non-sign-in call — including the 60-second "recently checked" fast path,
// which previously skipped this entirely.
//
// Imports the REAL @/auth (not mocked) so the actual jwtCallback logic runs; only
// the tenant-resolution layer is mocked, and these test cases never need the DB
// (the tenant check returns before any DB-touching code).
// ---------------------------------------------------------------------------

const tenantState = vi.hoisted(() => ({ requestSlug: 'tenant-a' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
}));

import { jwtCallback } from '@/auth';

describe('jwtCallback tenant binding (R2-1)', () => {
  beforeEach(() => {
    tenantState.requestSlug = 'tenant-a';
  });

  // (a) mismatch rejected on the FAST path (lastSessionCheck recent — would have
  // skipped the DB check entirely under the old code).
  it('rejects a token for tenant A on a tenant-B request, even on the 60s fast path', async () => {
    tenantState.requestSlug = 'tenant-b';
    const token: any = {
      id: 'user-1',
      role: 'admin',
      tenantSlug: 'tenant-a',
      sessionVersion: 1,
      lastSessionCheck: Date.now(), // "just checked" — fast path would normally short-circuit
    };

    const result = await jwtCallback({ token });
    expect(result).toBeNull();
  });

  // (a) mismatch rejected on the SLOW path (lastSessionCheck missing/old — would have
  // reached the DB check under the old code).
  it('rejects a token for tenant A on a tenant-B request on the slow (DB-check) path too', async () => {
    tenantState.requestSlug = 'tenant-b';
    const token: any = {
      id: 'user-1',
      role: 'admin',
      tenantSlug: 'tenant-a',
      sessionVersion: 1,
      // no lastSessionCheck — would have gone to the DB-check branch pre-fix
    };

    const result = await jwtCallback({ token });
    expect(result).toBeNull();
  });

  // (b) empty tenantSlug on the token is rejected outright, even if some request
  // somehow resolves to an empty slug too — a session must always be bound to a
  // real tenant.
  it('rejects a token with an empty tenantSlug', async () => {
    tenantState.requestSlug = '';
    const token: any = {
      id: 'user-1',
      role: 'admin',
      tenantSlug: '',
      sessionVersion: 1,
      lastSessionCheck: Date.now(),
    };

    const result = await jwtCallback({ token });
    expect(result).toBeNull();
  });

  // (c) matching tenant passes through (fast path — no DB needed to prove this).
  it('passes a token through when the tenant matches', async () => {
    tenantState.requestSlug = 'tenant-a';
    const lastSessionCheck = Date.now();
    const token: any = {
      id: 'user-1',
      role: 'admin',
      tenantSlug: 'tenant-a',
      sessionVersion: 1,
      lastSessionCheck,
    };

    const result = await jwtCallback({ token });
    expect(result).not.toBeNull();
    expect((result as any).id).toBe('user-1');
    expect((result as any).invalidated).toBeUndefined();
  });

  // getTenantSlug() throws on a host / x-tenant-slug header mismatch (tampering) —
  // jwtCallback must fail closed, not propagate the throw.
  it('fails closed when getTenantSlug() throws (header tampering)', async () => {
    tenantState.requestSlug = undefined as any; // force getTenantSlug() mock to misbehave below
    const { getTenantSlug } = await import('@/lib/tenant/context');
    vi.mocked(getTenantSlug).mockImplementationOnce(async () => {
      throw new Error('Tenant context mismatch — possible header tampering.');
    });

    const token: any = {
      id: 'user-1',
      role: 'admin',
      tenantSlug: 'tenant-a',
      sessionVersion: 1,
      lastSessionCheck: Date.now(),
    };

    const result = await jwtCallback({ token });
    expect(result).toBeNull();
  });
});
