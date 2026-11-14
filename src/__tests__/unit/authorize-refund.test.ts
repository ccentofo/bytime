import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * feature-plan-upstash-rate-limiting.md T23 (§6.7 items 2–3, Q2): authorizeCredentials counts every attempt first and
 * refunds at exactly one site: once for a success, for MFARequiredSignin and for an unexpected exception; never for a
 * counted failure, MFAInvalidSignin, or a refused gate. Input that fails the pre-gate checks (non-string, over-long or
 * NUL-carrying) is never counted. The store is mocked; the auth body's DB calls are mocked as in authorize-mfa-code.
 */

const h = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  allowed: true,
  lockoutThrows: false,
  locked: false,
  userQueryThrows: false,
  dbForAuthThrows: false,
  successThrows: false,
  consume: vi.fn(),
  refund: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/auth', async (importOriginal) => importOriginal()); // the REAL module (setup.ts mocks it globally)
vi.mock('next-auth', () => ({ default: () => ({ handlers: {}, auth: async () => null, signIn: async () => undefined, signOut: async () => undefined }) }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('@/lib/rate-limit/store', () => ({
  consume: async (name: string, id: string) => {
    h.consume(name, id);
    return { allowed: h.allowed, retryAfterMs: 0, source: 'memory', resetAt: Date.now() + 900_000 };
  },
  refund: async (...a: unknown[]) => { h.refund(...a); },
}));
vi.mock('@/server/internal/login-attempts', () => ({
  getLockoutInfo: async () => {
    if (h.lockoutThrows) throw new Error('workspace database unavailable');
    return { isLocked: h.locked, failedAttempts: h.locked ? 5 : 0, minutesRemaining: h.locked ? 10 : 0 };
  },
  recordFailedAttempt: async () => {},
  recordSuccessfulLogin: async () => { if (h.successThrows) throw new Error('insert failed'); },
}));
vi.mock('@/lib/encryption', () => ({ decrypt: (v: string) => v, encrypt: (v: string) => v }));
vi.mock('@/db', () => {
  const db = {
    select: () => ({ from: () => ({ where: async () => { if (h.userQueryThrows) throw new Error('query failed'); return h.user ? [h.user] : []; } }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    transaction: async () => false,
  };
  return {
    getDbForAuth: async () => { if (h.dbForAuthThrows) throw new Error('Unknown workspace'); return db; },
    getDbForUrl: () => db,
    getDb: async () => db,
  };
});

import { authorizeCredentials } from '@/auth';

const PASSWORD = 'CorrectHorseBattery9!';
const IP = '203.0.113.9';
let plainUser: Record<string, unknown>;
let mfaUser: Record<string, unknown>;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  plainUser = { id: 'u-1', email: 'jane@example.com', fullName: 'Jane', role: 'employee', isActive: true, passwordHash, totpEnabled: false, totpSecret: null, totpRecoveryCodes: null };
  mfaUser = { ...plainUser, totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' };
});
beforeEach(() => {
  Object.assign(h, { user: plainUser, allowed: true, lockoutThrows: false, locked: false, userQueryThrows: false, dbForAuthThrows: false, successThrows: false });
  h.consume.mockReset();
  h.refund.mockReset();
});

const attempt = (over: Record<string, unknown> = {}) => authorizeCredentials({ email: 'jane@example.com', password: PASSWORD, ...over }, IP);

describe('T23: exactly one refund for success, the MFA step and unexpected exceptions', () => {
  it('a success is refunded once, against the same IP identifier and the gate decision', async () => {
    expect(await attempt()).toMatchObject({ id: 'u-1' });
    expect(h.consume).toHaveBeenCalledWith('signInFailure', `ip:${IP}`);
    expect(h.refund).toHaveBeenCalledTimes(1);
    expect(h.refund).toHaveBeenCalledWith('signInFailure', `ip:${IP}`, expect.objectContaining({ allowed: true }));
  });

  it('MFARequiredSignin is refunded once', async () => {
    h.user = mfaUser;
    await expect(attempt()).rejects.toMatchObject({ code: 'mfa_required' });
    expect(h.refund).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['getLockoutInfo throws', () => { h.lockoutThrows = true; }],
    ['the user query throws', () => { h.userQueryThrows = true; }],
    ['recordSuccessfulLogin throws after a success', () => { h.successThrows = true; }],
  ])('%s → rethrown, refunded once', async (_label, arrange) => {
    arrange();
    await expect(attempt()).rejects.toBeInstanceOf(Error);
    expect(h.refund).toHaveBeenCalledTimes(1);
  });

  it('getDbForAuth throwing gives null and zero refunds (existing behaviour, §6.7)', async () => {
    h.dbForAuthThrows = true;
    expect(await attempt()).toBeNull();
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.refund).not.toHaveBeenCalled();
  });
});

describe('T23: counted failures are never refunded', () => {
  it.each([
    ['a wrong password', () => {}, { password: 'wrong' }],
    ['an unknown user', () => { h.user = null; }, {}],
    ['a locked account', () => { h.locked = true; }, {}],
  ])('%s → null, zero refunds', async (_label, arrange, over) => {
    arrange();
    expect(await attempt(over)).toBeNull();
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.refund).not.toHaveBeenCalled();
  });

  it('MFAInvalidSignin → thrown, zero refunds', async () => {
    h.user = mfaUser;
    await expect(attempt({ mfaCode: '000000' })).rejects.toMatchObject({ code: 'mfa_invalid' });
    expect(h.refund).not.toHaveBeenCalled();
  });

  it('a refused gate → rate_limited even with the right password, before any work, zero refunds', async () => {
    h.allowed = false;
    h.lockoutThrows = true; // would throw if the body ran
    await expect(attempt()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(h.refund).not.toHaveBeenCalled();
  });
});

describe('T23: input refused before the gate (nothing counted, nothing checked)', () => {
  it.each([
    ['a numeric password', { password: 123456 }],
    ['a numeric email', { email: 42 }],
    ['an empty password', { password: '' }],
    ['a 256-character email', { email: `${'a'.repeat(244)}@example.com` }],
    ['an email with a NUL', { email: 'jane\u0000@example.com' }],
    ['a password with a NUL', { password: `${PASSWORD}\u0000` }],
  ])('%s → null, zero consume, zero refund', async (label, over: Record<string, unknown>) => {
    if (label.includes('256')) expect(over.email).toHaveLength(256);
    h.lockoutThrows = true; // would throw if the body ran
    expect(await attempt(over)).toBeNull();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.refund).not.toHaveBeenCalled();
  });

  it('a 255-character email is still checked (counted)', async () => {
    const email = `${'a'.repeat(243)}@example.com`;
    expect(email).toHaveLength(255);
    h.user = null;
    expect(await attempt({ email })).toBeNull();
    expect(h.consume).toHaveBeenCalledTimes(1);
  });
});
