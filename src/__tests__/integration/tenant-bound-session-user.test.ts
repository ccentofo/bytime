import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// R2-1 (d): defense-in-depth tenant check in getSessionUser() itself, independent
// of the jwt callback (covered in tenant-bound-jwt.test.ts). Mocks @/auth directly
// (unlike tenant-bound-jwt.test.ts, which needs the REAL @/auth) so the session's
// claimed tenantSlug can be set arbitrarily; @/lib/session itself is real.
// ---------------------------------------------------------------------------

const tenantState = vi.hoisted(() => ({ requestSlug: 'tenant-a' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
}));

const authState = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
}));

vi.mock('@/auth', () => ({
  auth: async () => authState.session,
}));

import { getSessionUser } from '@/lib/session';

describe('getSessionUser tenant binding (R2-1d)', () => {
  beforeEach(() => {
    tenantState.requestSlug = 'tenant-a';
    authState.session = null;
  });

  it('returns null when the session tenantSlug does not match the request tenant', async () => {
    authState.session = {
      user: { id: 'user-1', email: 'u@test.dev', fullName: 'U Ser', role: 'admin', tenantSlug: 'tenant-a' },
    };
    tenantState.requestSlug = 'tenant-b';

    const user = await getSessionUser();
    expect(user).toBeNull();
  });

  it('returns null when the session has no tenantSlug at all', async () => {
    authState.session = {
      user: { id: 'user-1', email: 'u@test.dev', fullName: 'U Ser', role: 'admin' },
    };

    const user = await getSessionUser();
    expect(user).toBeNull();
  });

  it('returns the user when the tenant matches', async () => {
    authState.session = {
      user: { id: 'user-1', email: 'u@test.dev', fullName: 'U Ser', role: 'admin', tenantSlug: 'tenant-a' },
    };

    const user = await getSessionUser();
    expect(user).not.toBeNull();
    expect(user?.id).toBe('user-1');
  });

  it('returns null when there is no session at all', async () => {
    authState.session = null;
    const user = await getSessionUser();
    expect(user).toBeNull();
  });
});
