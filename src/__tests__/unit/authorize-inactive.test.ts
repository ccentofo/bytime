import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * SWEEP-FINDINGS.md A1-G3: sign-in refuses a deactivated user even with the right password (src/auth.ts, the
 * `!user.isActive` check), records the failure against the email (it counts toward the lockout), records no success,
 * and gives no refund of the per-IP failure count. The harness is authorize-refund.test.ts's.
 */

const h = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  failed: [] as string[],
  succeeded: [] as string[],
  refund: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/auth', async (importOriginal) => importOriginal()); // the REAL module (setup.ts mocks it globally)
vi.mock('next-auth', () => ({ default: () => ({ handlers: {}, auth: async () => null, signIn: async () => undefined, signOut: async () => undefined }) }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('@/lib/rate-limit/store', () => ({
  consume: async () => ({ allowed: true, retryAfterMs: 0, source: 'memory', resetAt: Date.now() + 900_000 }),
  refund: async (...a: unknown[]) => { h.refund(...a); },
}));
vi.mock('@/server/internal/login-attempts', () => ({
  getLockoutInfo: async () => ({ isLocked: false, failedAttempts: 0, minutesRemaining: 0 }),
  recordFailedAttempt: async (_db: unknown, email: string) => { h.failed.push(email); },
  recordSuccessfulLogin: async (_db: unknown, email: string) => { h.succeeded.push(email); },
}));
vi.mock('@/lib/encryption', () => ({ decrypt: (v: string) => v, encrypt: (v: string) => v }));
vi.mock('@/db', () => {
  const db = {
    select: () => ({ from: () => ({ where: async () => (h.user ? [h.user] : []) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    transaction: async () => false,
  };
  return { getDbForAuth: async () => db, getDbForUrl: () => db, getDb: async () => db };
});

import { authorizeCredentials } from '@/auth';

const PASSWORD = 'CorrectHorseBattery9!';
let active: Record<string, unknown>;
beforeAll(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  active = { id: 'u-1', email: 'jane@example.com', fullName: 'Jane', role: 'admin', isActive: true, passwordHash, totpEnabled: false, totpSecret: null, totpRecoveryCodes: null };
});
beforeEach(() => {
  h.user = active;
  h.failed = [];
  h.succeeded = [];
  h.refund.mockReset();
});

describe('A1-G3: a deactivated user cannot sign in, even with the right password', () => {
  it('active + right password → signed in (control)', async () => {
    expect(await authorizeCredentials({ email: 'jane@example.com', password: PASSWORD }, '203.0.113.5')).toMatchObject({ id: 'u-1' });
    expect(h.succeeded).toEqual(['jane@example.com']);
  });

  it('inactive + right password → null, a failed attempt recorded, no success, no refund', async () => {
    h.user = { ...active, isActive: false };
    expect(await authorizeCredentials({ email: ' Jane@Example.com ', password: PASSWORD }, '203.0.113.5')).toBeNull();
    expect(h.failed).toEqual(['jane@example.com']);
    expect(h.succeeded).toEqual([]);
    expect(h.refund).not.toHaveBeenCalled();
  });

  it('inactive with two-step on → still refused before any code is asked for (no MFA prompt leaks the password was right)', async () => {
    h.user = { ...active, isActive: false, totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' };
    expect(await authorizeCredentials({ email: 'jane@example.com', password: PASSWORD }, '203.0.113.5')).toBeNull();
    expect(h.failed).toEqual(['jane@example.com']);
  });
});
