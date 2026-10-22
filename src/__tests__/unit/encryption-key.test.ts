import { describe, it, expect, afterEach, vi } from 'vitest';

// Audit fix: a production deploy with a missing or placeholder ENCRYPTION_KEY must fail closed, never fall back to
// a derivable key (it protects every tenant's DB credentials, TOTP secrets and integration tokens).
const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; vi.resetModules(); });

async function load() {
  return vi.importActual<typeof import('@/lib/encryption')>('@/lib/encryption');
}

describe('ENCRYPTION_KEY in production', () => {
  it.each([[undefined], ['replace-with-openssl-rand-hex-32'], ['abc123']])('refuses %s', async (key) => {
    vi.stubEnv('NODE_ENV', 'production');
    if (key === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = key;
    const { encrypt } = await load();
    expect(() => encrypt('secret')).toThrow(/ENCRYPTION_KEY/);
  });

  it('works with a 64-hex key and round-trips', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { encrypt, decrypt } = await load();
    expect(decrypt(encrypt('secret'))).toBe('secret');
  });

  it('development keeps the local fallback', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.ENCRYPTION_KEY;
    const { encrypt, decrypt } = await load();
    expect(decrypt(encrypt('x'))).toBe('x');
  });
});
