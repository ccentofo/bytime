import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * getTenantOrThrow is the FAIL-CLOSED gate for the whole app: every getDb() call goes
 * through it. If it ever returns a tenant it shouldn't (or fails open), that is a
 * cross-tenant exposure or a broken access gate.
 *
 * Tenant identity is derived from the HOST header (source of truth); the proxy-injected
 * x-tenant-slug is defense-in-depth and must agree with host. We mock both header sources
 * and the registry so we can drive every branch deterministically. APP_ROOT_DOMAIN defaults
 * to 'localhost', so a tenant host is `<slug>.localhost`.
 */

// context.ts starts with `import 'server-only'` — neutralize it for the test runtime.
vi.mock('server-only', () => ({}));

let currentHost: string | null = null;
let currentInjected = ''; // simulates the proxy-injected (or client-forged) x-tenant-slug
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) => {
      if (k === 'host') return currentHost;
      if (k === 'x-tenant-slug') return currentInjected;
      return null;
    },
  }),
}));

const fakeTenants: Record<string, { id: string; slug: string; name: string; status: string; plan: string; dbUrl: string }> = {
  acme:  { id: '1', slug: 'acme',  name: 'Acme',  status: 'active',       plan: 'pro',   dbUrl: 'postgres://acme' },
  beta:  { id: '2', slug: 'beta',  name: 'Beta',  status: 'suspended',    plan: 'trial', dbUrl: 'postgres://beta' },
  gamma: { id: '3', slug: 'gamma', name: 'Gamma', status: 'deleting',     plan: 'trial', dbUrl: 'postgres://gamma' },
  delta: { id: '4', slug: 'delta', name: 'Delta', status: 'provisioning', plan: 'trial', dbUrl: 'postgres://delta' },
};
vi.mock('@/lib/tenant/registry', () => ({
  getTenantBySlug: async (slug: string) => fakeTenants[slug] ?? null,
}));

import { getTenantOrThrow } from '@/lib/tenant/context';

/** Simulate a request arriving on a tenant subdomain (proxy injected a matching header). */
function onTenant(slug: string) { currentHost = `${slug}.localhost`; currentInjected = slug; }

beforeEach(() => { currentHost = null; currentInjected = ''; });

describe('getTenantOrThrow — fail-closed tenant gate', () => {
  it('resolves an active tenant', async () => {
    onTenant('acme');
    const t = await getTenantOrThrow();
    expect(t.slug).toBe('acme');
    expect(t.dbUrl).toBe('postgres://acme');
  });

  it('works when the proxy did NOT inject a header (host is the source of truth)', async () => {
    currentHost = 'acme.localhost';
    currentInjected = ''; // proxy gap — must still resolve from host
    const t = await getTenantOrThrow();
    expect(t.slug).toBe('acme');
  });

  it('throws on a forged x-tenant-slug that disagrees with the host', async () => {
    currentHost = 'acme.localhost';
    currentInjected = 'beta'; // attacker tries to read beta while on acme's host
    await expect(getTenantOrThrow()).rejects.toThrow(/mismatch|tampering/i);
  });

  it('throws when no tenant (apex host), even if a header is forged', async () => {
    currentHost = 'localhost';
    currentInjected = 'victim';
    await expect(getTenantOrThrow()).rejects.toThrow(/mismatch|tampering|No tenant/i);
  });

  it('throws for an unknown workspace', async () => {
    onTenant('does-not-exist');
    await expect(getTenantOrThrow()).rejects.toThrow(/Unknown workspace/i);
  });

  it('throws for a suspended tenant (billing gate)', async () => {
    onTenant('beta');
    await expect(getTenantOrThrow()).rejects.toThrow(/suspended/i);
  });

  it('throws for a tenant being deleted', async () => {
    onTenant('gamma');
    await expect(getTenantOrThrow()).rejects.toThrow(/removed|deleting/i);
  });

  it('throws for a tenant still provisioning (serve only active)', async () => {
    onTenant('delta');
    await expect(getTenantOrThrow()).rejects.toThrow(/set up|provision/i);
  });
});
