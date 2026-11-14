import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * feature-plan-upstash-rate-limiting.md T1 (§6.2 import rule, §6.3). Deliberately NO `server-only` mock: the store and
 * everything it imports at the top must load in plain Node, because tests like v1-api-auth load it through
 * `@/lib/rate-limit` without one.
 */

import { rateLimitId, ipIdentifier } from '@/lib/rate-limit/identifier';

afterEach(() => { vi.unstubAllEnvs(); });

describe('rate-limit identifiers (T1)', () => {
  it('rateLimitId is a 64-hex HMAC: never the raw value, stable, different per value', () => {
    vi.stubEnv('SIGNUP_IP_SALT', 'test-salt');
    const id = rateLimitId('ip:203.0.113.5');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain('203.0.113.5');
    expect(rateLimitId('ip:203.0.113.5')).toBe(id);
    expect(rateLimitId('ip:203.0.113.6')).not.toBe(id);
  });

  it('differs from the signup IP hash (sha256(salt + key)) of the same address', async () => {
    vi.stubEnv('SIGNUP_IP_SALT', 'test-salt');
    const { createHash } = await import('crypto');
    const signupHash = createHash('sha256').update('test-salt' + '203.0.113.5').digest('hex');
    expect(rateLimitId(ipIdentifier('203.0.113.5'))).not.toBe(signupHash);
    expect(rateLimitId('203.0.113.5')).not.toBe(signupHash);
  });

  it('the secret is SIGNUP_IP_SALT: another salt gives another id', () => {
    vi.stubEnv('SIGNUP_IP_SALT', 'salt-a');
    const a = rateLimitId('ip:203.0.113.5');
    vi.stubEnv('SIGNUP_IP_SALT', 'salt-b');
    expect(rateLimitId('ip:203.0.113.5')).not.toBe(a);
  });

  it('without a salt it still hashes (a per-process random secret, never the public dev salt)', async () => {
    vi.stubEnv('SIGNUP_IP_SALT', '');
    const id = rateLimitId('ip:203.0.113.5');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const { createHmac } = await import('crypto');
    expect(id).not.toBe(createHmac('sha256', 'cadenzpoint-dev-signup-ip-salt').update('cp-rate-limit:v1:ip:203.0.113.5').digest('hex'));
  });

  it('ipIdentifier normalizes: one id per IPv6 /64, IPv4-in-IPv6 is the IPv4, junk is unknown', () => {
    expect(ipIdentifier('203.0.113.5')).toBe('ip:203.0.113.5');
    expect(ipIdentifier('2001:db8:1:2:aaaa::1')).toBe(ipIdentifier('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    expect(ipIdentifier('2001:db8:1:2::1')).not.toBe(ipIdentifier('2001:db8:1:3::1'));
    expect(ipIdentifier('::ffff:203.0.113.5')).toBe(ipIdentifier('203.0.113.5'));
    expect(ipIdentifier('unknown')).toBe('ip:unknown');
    expect(ipIdentifier('not-an-ip')).toBe('ip:unknown');
  });

  it('@/lib/rate-limit and @/lib/rate-limit/store import with no server-only mock', async () => {
    const rl = await import('@/lib/rate-limit');
    const store = await import('@/lib/rate-limit/store');
    expect(typeof rl.checkSlugLookupRateLimit).toBe('function');
    expect(typeof rl.checkRateLimit).toBe('function');
    expect(typeof store.consume).toBe('function');
    expect(typeof store.refund).toBe('function');
  });
});
