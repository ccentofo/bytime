import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-launch-hardening.md H5 (§8.2, §8.3): Connect QuickBooks is the startQuickBooksConnect server action.
 * T12: as an admin it sets the host-only nonce cookie and redirects to Intuit with a signed state bound to this tenant,
 * admin, provider and nonce. T13: every refusal redirects without setting a cookie. T15: the CSP lets the form-POST
 * redirect reach Intuit (form-action), and nothing else is added.
 */

const h = vi.hoisted(() => ({
  set: vi.fn(),
  actor: { kind: 'admin' as 'admin' | 'unauthenticated' | 'forbidden' },
  slug: 'acme' as string,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: h.set }) }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message === 'NEXT_REDIRECT') throw e; },
}));
vi.mock('@/lib/session', async () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); }
  }
  return {
    AuthorizationError,
    requireAdmin: vi.fn(),
    requireAdminFresh: async () => {
      if (h.actor.kind === 'admin') return { id: 'admin-1', role: 'admin', email: 'a@acme.test', fullName: 'A' };
      throw new AuthorizationError(h.actor.kind, 'no');
    },
  };
});
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => h.slug }));
vi.mock('@/db', () => ({ getDb: vi.fn(), getDbForWrite: vi.fn() }));

import { startQuickBooksConnect } from '@/server/actions/integrations';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';

/** Runs the action and returns the URL it redirected to (it always ends in redirect()). */
async function redirectOf(): Promise<string> {
  try {
    await startQuickBooksConnect();
  } catch (e) {
    if (e instanceof Error && e.message === 'NEXT_REDIRECT') return (e as Error & { url: string }).url;
    throw e;
  }
  throw new Error('startQuickBooksConnect returned without redirecting');
}

const ENV = { QBO_CLIENT_ID: 'client-123', QBO_CLIENT_SECRET: 'secret-456', OAUTH_STATE_SECRET: 'state-secret-for-tests-0123456789' };

beforeEach(() => {
  h.set.mockClear();
  h.actor.kind = 'admin';
  h.slug = 'acme';
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('startQuickBooksConnect (T12)', () => {
  it('admin: sets qbo_oauth_nonce (httpOnly, secure, lax, 600 s, path /, no domain) and redirects to Intuit with a matching signed state', async () => {
    const url = new URL(await redirectOf());
    expect(`${url.origin}${url.pathname}`).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(url.searchParams.get('client_id')).toBe('client-123');

    expect(h.set).toHaveBeenCalledTimes(1);
    const [name, nonce, opts] = h.set.mock.calls[0];
    expect(name).toBe('qbo_oauth_nonce');
    expect(opts).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
    expect(opts).not.toHaveProperty('domain');

    const state = verifyOAuthState(url.searchParams.get('state'));
    expect(state).toMatchObject({ tenantSlug: 'acme', userId: 'admin-1', provider: 'quickbooks_online', nonce });
  });
});

describe('startQuickBooksConnect refusals (T13): a redirect, and no cookie', () => {
  it('not an admin → /timesheet', async () => {
    h.actor.kind = 'forbidden';
    expect(await redirectOf()).toBe('/timesheet');
    expect(h.set).not.toHaveBeenCalled();
  });
  it('unauthenticated → /login', async () => {
    h.actor.kind = 'unauthenticated';
    expect(await redirectOf()).toBe('/login');
    expect(h.set).not.toHaveBeenCalled();
  });
  it('no tenant slug → the config-missing redirect', async () => {
    h.slug = '';
    expect(await redirectOf()).toBe('/settings/integrations?error=qbo_config_missing');
    expect(h.set).not.toHaveBeenCalled();
  });
  it('QuickBooks not configured (the auth-URL builder throws) → the config-missing redirect', async () => {
    vi.stubEnv('QBO_CLIENT_ID', '');
    expect(await redirectOf()).toBe('/settings/integrations?error=qbo_config_missing');
    expect(h.set).not.toHaveBeenCalled();
  });
});

describe('CSP form-action (T15)', () => {
  it("form-action is exactly 'self' https://*.intuit.com, under either CSP header", async () => {
    const config = (await import('../../../next.config')).default as { headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>> };
    const rules = await config.headers();
    const csp = rules.flatMap((r) => r.headers).find((x) => x.key === 'Content-Security-Policy' || x.key === 'Content-Security-Policy-Report-Only');
    expect(csp).toBeDefined();
    const directives = csp!.value.split(';').map((d) => d.trim());
    expect(directives.filter((d) => d.startsWith('form-action'))).toEqual(["form-action 'self' https://*.intuit.com"]);
  });
});
