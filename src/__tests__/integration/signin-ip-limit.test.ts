import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { encrypt } from '@/lib/encryption';
import { getTestDb, cleanupTestData } from './helpers';

/**
 * feature-plan-upstash-rate-limiting.md T17, T18 (Q2, §6.7) and T21 (§6.8), against a real tenant database.
 * Memory mode is forced (no Upstash variables, a fresh store per test); each scenario uses its own IP. The workspace
 * database is the test DB (getDbForAuth mocked, as in password-reset.test.ts); DB errors are injected through the
 * importOriginal pattern of account-security.test.ts.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDbForAuth: async () => getTestDb(),
}));

const inject = vi.hoisted(() => ({ lockoutThrows: false }));
vi.mock('@/server/internal/login-attempts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/internal/login-attempts')>();
  return {
    ...real,
    getLockoutInfo: async (...args: Parameters<typeof real.getLockoutInfo>) => {
      if (inject.lockoutThrows) throw new Error('workspace database unavailable');
      return real.getLockoutInfo(...args);
    },
  };
});

import { authorizeCredentials } from '@/auth';
import { __resetForTests } from '@/lib/rate-limit/store';

const PASSWORD = 'TestPass123!';
const MFA_SECRET = 'JBSWY3DPEHPK3PXP';

async function makeUser(email: string, mfa = false) {
  await getTestDb().insert(schema.users).values({
    email, fullName: 'Limit User', role: 'employee', isActive: true, passwordHash: await bcrypt.hash(PASSWORD, 4),
    ...(mfa ? { totpEnabled: true, totpSecret: encrypt(MFA_SECRET) } : {}),
  });
  return email;
}

async function makeUsers(prefix: string, n: number) {
  const emails: string[] = [];
  for (let i = 0; i < n; i++) emails.push(await makeUser(`${prefix}-${i}@limit.test`));
  return emails;
}

const signIn = (email: string, password: string, ip: string, mfaCode?: string) =>
  authorizeCredentials({ email, password, ...(mfaCode !== undefined ? { mfaCode } : {}) }, ip);

async function attemptRows(): Promise<number> {
  const [row] = await getTestDb().select({ n: sql<number>`count(*)::int` }).from(schema.loginAttempts);
  return row.n;
}

/** n wrong-password failures from `ip`, spread 4 per email so no account locks. */
async function failures(emails: string[], n: number, ip: string) {
  for (let i = 0; i < n; i++) expect(await signIn(emails[Math.floor(i / 4)], 'wrong-password', ip)).toBeNull();
}

beforeEach(async () => {
  await cleanupTestData();
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[k];
  __resetForTests();
  inject.lockoutThrows = false;
});

describe('T17: 20 failed sign-ins per IP per 15 minutes (Q2)', () => {
  it('after 20 failures across 5 emails, the right password is refused with rate_limited and writes no row; another IP still signs in', async () => {
    const emails = await makeUsers('t17a', 5);
    await failures(emails, 20, '203.0.113.9');
    const before = await attemptRows();
    expect(before).toBe(20);
    await expect(signIn(emails[0], PASSWORD, '203.0.113.9')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await attemptRows()).toBe(before);
    expect(await signIn(emails[0], PASSWORD, '203.0.113.10')).toMatchObject({ email: emails[0] });
  });

  it('25 successful sign-ins from one IP all pass (each is refunded)', async () => {
    const email = await makeUser('t17b@limit.test');
    for (let i = 0; i < 25; i++) expect(await signIn(email, PASSWORD, '203.0.113.11')).toMatchObject({ email });
  });

  it('the MFA step (mfa_required) is not counted; a wrong MFA code is', async () => {
    const mfa = await makeUser('t17c-mfa@limit.test', true);
    for (let i = 0; i < 25; i++) await expect(signIn(mfa, PASSWORD, '203.0.113.12')).rejects.toMatchObject({ code: 'mfa_required' });
    const emails = await makeUsers('t17c', 5);
    await failures(emails, 19, '203.0.113.12');
    await expect(signIn(mfa, PASSWORD, '203.0.113.12', '000000')).rejects.toMatchObject({ code: 'mfa_invalid' }); // the 20th
    await expect(signIn(mfa, PASSWORD, '203.0.113.12')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it("a locked account's attempts count", async () => {
    const email = await makeUser('t17d@limit.test');
    for (let i = 0; i < 20; i++) expect(await signIn(email, 'wrong-password', '203.0.113.13')).toBeNull(); // locks at 5, keeps counting
    await expect(signIn(email, 'wrong-password', '203.0.113.13')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('a workspace-database error is refunded and rethrown (no self-lockout)', async () => {
    const email = await makeUser('t17e@limit.test');
    inject.lockoutThrows = true;
    for (let i = 0; i < 25; i++) await expect(signIn(email, PASSWORD, '203.0.113.14')).rejects.toThrow('workspace database unavailable');
    inject.lockoutThrows = false;
    expect(await signIn(email, PASSWORD, '203.0.113.14')).toMatchObject({ email });
  });
});

describe('T18: parallel attempts are counted atomically', () => {
  it('50 concurrent wrong-password attempts from one IP → exactly 20 null and 30 rate_limited', async () => {
    const emails = await makeUsers('t18', 5);
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => signIn(emails[i % 5], 'wrong-password', '203.0.113.15')));
    const nulls = results.filter((r) => r.status === 'fulfilled' && r.value === null).length;
    const limited = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'rate_limited').length;
    expect({ nulls, limited }).toEqual({ nulls: 20, limited: 30 });
  });
});

describe('T21: login_attempts.ip_address stays empty', () => {
  it('a non-null ip_address violates login_attempts_no_raw_ip; NULL is accepted', async () => {
    const db = getTestDb();
    const err = await db.insert(schema.loginAttempts).values({ email: 'x@limit.test', ipAddress: '1.2.3.4', successful: false })
      .then(() => null, (e: unknown) => e as { message?: string; cause?: { constraint_name?: string; message?: string } });
    expect(err).not.toBeNull();
    expect(`${err?.cause?.constraint_name ?? ''} ${err?.cause?.message ?? ''} ${err?.message ?? ''}`).toContain('login_attempts_no_raw_ip');
    await db.insert(schema.loginAttempts).values({ email: 'x@limit.test', ipAddress: null, successful: false });
    expect(await attemptRows()).toBe(1);
  });
});
