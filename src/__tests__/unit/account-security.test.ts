import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcryptReal from 'bcryptjs';
import * as OTPAuth from 'otpauth';

/**
 * feature-plan-launch-blockers.md P3 / §9 "Account security" (unit form): re-authentication for account-security
 * changes checks the lockout BEFORE bcrypt, records a wrong password in the shared login_attempts counter, and
 * handles an account with no password. Real-DB scenarios (concurrent recovery code, the 6th attempt) are in
 * src/__tests__/integration/account-security.test.ts.
 */

vi.mock('server-only', () => ({}));

/** Each select() resolves to the next queued result; insert().values() and update() are recorded. */
const fake = vi.hoisted(() => {
  const state = { results: [] as unknown[][], inserts: [] as unknown[], updates: 0 };
  const next = () => Promise.resolve(state.results.shift() ?? []);
  const db = {
    select: () => ({
      from: () => ({
        // Lazy: the queued result is taken when the chain is awaited, wherever it ends (where / orderBy / limit).
        where: () => ({
          then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) => next().then(res, rej),
          orderBy: () => ({
            then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) => next().then(res, rej),
            limit: () => next(),
          }),
        }),
      }),
    }),
    insert: () => ({ values: async (v: unknown) => { state.inserts.push(v); } }),
    update: () => ({ set: () => ({ where: async () => { state.updates++; } }) }),
  };
  return { state, db };
});
vi.mock('@/db', () => ({ getDbForAuth: async () => fake.db, getDb: async () => fake.db }));

const compare = vi.hoisted(() => ({ spy: null as null | ReturnType<typeof vi.fn> }));
vi.mock('bcryptjs', async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof bcryptReal }>()).default;
  compare.spy = vi.fn((a: string, b: string) => real.compare(a, b));
  return { default: { ...real, compare: compare.spy } };
});

vi.mock('@/lib/session', () => ({
  AuthorizationError: class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  },
  requireSession: async () => ({ id: 'u1', email: 'jane@acme.com', fullName: 'Jane', role: 'employee' }),
}));

import { verifyCurrentPassword } from '@/server/internal/login-attempts';
import { completeMFASetup } from '@/server/actions/mfa';

const HASH = bcryptReal.hashSync('Correct123!', 4);
const SECRET = 'JBSWY3DPEHPK3PXP';
/** A currently-valid code, so only the password check can refuse (the old code accepted this). */
const validCode = () => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(SECRET) }).generate();
const failures = (n: number) => Array.from({ length: n }, () => ({ attemptedAt: new Date(), successful: false }));

beforeEach(() => {
  fake.state.results = [];
  fake.state.inserts = [];
  fake.state.updates = 0;
  compare.spy!.mockClear();
});

describe('verifyCurrentPassword', () => {
  it('an account with no password → "Set a password first", no bcrypt', async () => {
    await expect(verifyCurrentPassword(fake.db as never, 'jane@acme.com', null, 'x')).resolves.toEqual({ ok: false, error: 'Set a password first.' });
    expect(compare.spy).not.toHaveBeenCalled();
  });

  it('a locked account is refused BEFORE bcrypt runs, even with the right password', async () => {
    fake.state.results = [failures(5), []]; // 5 recent failures, no later success
    const result = await verifyCurrentPassword(fake.db as never, 'jane@acme.com', HASH, 'Correct123!');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/too many failed attempts/i);
    expect(compare.spy).not.toHaveBeenCalled();
    expect(fake.state.inserts).toHaveLength(0);
  });

  it('a wrong password is recorded in the shared login_attempts counter', async () => {
    fake.state.results = [[], []];
    await expect(verifyCurrentPassword(fake.db as never, 'jane@acme.com', HASH, 'wrong')).resolves.toEqual({ ok: false, error: 'Current password is incorrect.' });
    expect(fake.state.inserts).toEqual([expect.objectContaining({ email: 'jane@acme.com', successful: false })]);
  });

  it('the right password passes and records nothing', async () => {
    fake.state.results = [[], []];
    await expect(verifyCurrentPassword(fake.db as never, 'jane@acme.com', HASH, 'Correct123!')).resolves.toEqual({ ok: true });
    expect(fake.state.inserts).toHaveLength(0);
  });
});

describe('completeMFASetup requires the current password', () => {
  it('the right current password and a valid code enable MFA', async () => {
    fake.state.results = [[{ passwordHash: HASH }], [], []];
    const result = await completeMFASetup({ pendingSecret: SECRET, code: validCode(), currentPassword: 'Correct123!' });
    expect(result.ok).toBe(true);
    expect(fake.state.updates).toBe(1);
  });

  it('a wrong current password is refused and nothing is saved', async () => {
    fake.state.results = [[{ passwordHash: HASH }], [], []];
    const result = await completeMFASetup({ pendingSecret: SECRET, code: validCode(), currentPassword: 'wrong' });
    expect(result).toEqual({ ok: false, code: 'validation', error: 'Current password is incorrect.' });
    expect(fake.state.updates).toBe(0);
  });

  it('an account without a password is told to set one first', async () => {
    fake.state.results = [[{ passwordHash: null }]];
    const result = await completeMFASetup({ pendingSecret: SECRET, code: validCode(), currentPassword: 'anything' });
    expect(result).toEqual({ ok: false, code: 'validation', error: 'Set a password first.' });
    expect(fake.state.updates).toBe(0);
  });
});
