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

describe('A1-G9 (SWEEP-FINDINGS.md): AES-GCM uses a fresh random IV per encryption', () => {
  it('the same text encrypts differently each time, with different IV bytes, and both decrypt', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    const { encrypt, decrypt } = await load();
    const a = encrypt('postgresql://app:pw@db/acme');
    const b = encrypt('postgresql://app:pw@db/acme');
    expect(a).not.toBe(b);
    const ivA = Buffer.from(a, 'base64').subarray(0, 16);
    const ivB = Buffer.from(b, 'base64').subarray(0, 16);
    expect(ivA.equals(ivB)).toBe(false);
    expect(ivA.equals(Buffer.alloc(16))).toBe(false);
    expect(decrypt(a)).toBe('postgresql://app:pw@db/acme');
    expect(decrypt(b)).toBe('postgresql://app:pw@db/acme');
  });

  it('across many encryptions no IV repeats', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    const { encrypt } = await load();
    const ivs = new Set(Array.from({ length: 200 }, () => Buffer.from(encrypt('x'), 'base64').subarray(0, 16).toString('hex')));
    expect(ivs.size).toBe(200);
  });
});
