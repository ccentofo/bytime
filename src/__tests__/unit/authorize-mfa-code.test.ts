import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * feature-plan-hotfix-mfa-qr.md §7 (server, unit — runs without a database; integration/mfa-signin.test.ts covers the
 * same against Postgres): authorizeCredentials treats a missing, blank or non-string mfaCode, or the strings
 * "undefined" / "null" (URLSearchParams serialises an undefined value as "undefined"), as NO code submitted — it throws
 * mfa_required and records no failed attempt. A real wrong code is still mfa_invalid and still counts.
 */

const h = vi.hoisted(() => ({ user: null as Record<string, unknown> | null, recordFailedAttempt: vi.fn(), recordSuccessfulLogin: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/auth', async (importOriginal) => importOriginal()); // the REAL module (setup.ts mocks it globally)
// Only the NextAuth wrapper is stubbed (its ESM build imports 'next/server', which the unit runner can't resolve);
// authorizeCredentials and CredentialsSignin (@auth/core) are real.
vi.mock('next-auth', () => ({ default: () => ({ handlers: {}, auth: async () => null, signIn: async () => undefined, signOut: async () => undefined }) }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('@/server/internal/login-attempts', () => ({
  getLockoutInfo: async () => ({ isLocked: false, failedAttempts: 0, minutesRemaining: 0 }),
  recordFailedAttempt: h.recordFailedAttempt,
  recordSuccessfulLogin: h.recordSuccessfulLogin,
}));
vi.mock('@/lib/encryption', () => ({ decrypt: (v: string) => v, encrypt: (v: string) => v }));
vi.mock('@/db', () => {
  // Just enough of drizzle for authorizeCredentials: the user lookup, and the TOTP step claim (never reached here).
  const db = {
    select: () => ({ from: () => ({ where: async () => (h.user ? [h.user] : []) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    transaction: async () => false,
  };
  return { getDbForAuth: async () => db, getDbForUrl: () => db, getDb: async () => db };
});

import { authorizeCredentials } from '@/auth';

const PASSWORD = 'CorrectHorseBattery9!';
beforeAll(async () => {
  h.user = {
    id: 'u-1', email: 'jane@example.com', fullName: 'Jane', role: 'employee', isActive: true,
    passwordHash: await bcrypt.hash(PASSWORD, 4), totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP', totpRecoveryCodes: null,
  };
});
beforeEach(() => { h.recordFailedAttempt.mockReset(); h.recordSuccessfulLogin.mockReset(); });

describe('authorizeCredentials: "no code submitted" (hotfix §7)', () => {
  it.each([['undefined'], ['null'], [''], ['   '], ['  undefined  '], [undefined], [null], [123456]])(
    'mfaCode %j → mfa_required, and no failed attempt is recorded',
    async (mfaCode) => {
      await expect(authorizeCredentials({ email: 'jane@example.com', password: PASSWORD, mfaCode })).rejects.toMatchObject({ code: 'mfa_required' });
      expect(h.recordFailedAttempt).not.toHaveBeenCalled();
    },
  );

  it('a real wrong code ("000000") is still mfa_invalid and still counts toward the lockout', async () => {
    await expect(authorizeCredentials({ email: 'jane@example.com', password: PASSWORD, mfaCode: '000000' })).rejects.toMatchObject({ code: 'mfa_invalid' });
    expect(h.recordFailedAttempt).toHaveBeenCalledTimes(1);
  });

  it('a wrong password still counts (before any code is asked for)', async () => {
    expect(await authorizeCredentials({ email: 'jane@example.com', password: 'wrong', mfaCode: 'undefined' })).toBeNull();
    expect(h.recordFailedAttempt).toHaveBeenCalledTimes(1);
  });
});
