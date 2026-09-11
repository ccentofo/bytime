import { describe, it, expect } from 'vitest';
import { tenantFromHost } from '@/lib/tenant/host';

/**
 * Tenant-host parsing is the FIRST line of cross-tenant isolation: a wrong answer here
 * either denies service (fail-closed) or — worse — routes a request to the wrong tenant DB.
 * These tests assume the default APP_ROOT_DOMAIN of 'localhost' (env-driven in proxy.ts).
 */
describe('tenantFromHost — subdomain → tenant slug', () => {
  it('extracts the tenant label from a tenant subdomain', () => {
    expect(tenantFromHost('acme.localhost')).toBe('acme');
    expect(tenantFromHost('acme.localhost:3000')).toBe('acme'); // port stripped
  });

  it('returns null for the apex / www host (marketing, no tenant)', () => {
    expect(tenantFromHost('localhost')).toBeNull();
    expect(tenantFromHost('www.localhost')).toBeNull();
    expect(tenantFromHost('localhost:3000')).toBeNull();
  });

  it('returns null for reserved subdomains', () => {
    for (const r of ['www', 'app', 'api', 'admin', 'static', 'assets']) {
      expect(tenantFromHost(`${r}.localhost`)).toBeNull();
    }
  });

  it('returns null for a missing host', () => {
    expect(tenantFromHost(null)).toBeNull();
  });

  it('rejects nested/forged subdomains (label containing a dot)', () => {
    // 'evil.acme.localhost' must NOT resolve to 'acme' or 'evil.acme' — it is not a flat tenant label.
    expect(tenantFromHost('evil.acme.localhost')).toBeNull();
  });

  it('returns null for a host that is not under the root domain', () => {
    expect(tenantFromHost('acme.evil.com')).toBeNull();
  });
});
