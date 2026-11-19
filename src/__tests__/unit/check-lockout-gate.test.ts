import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A1-D6 (lead's decision Q1): the public checkLockout action is gated by the IP's sign-in failure
 * budget as a PEEK. With the real store (memory mode, fresh per case): an allowed check is counted and given back, so
 * any number of checks leave the 20-failure budget exactly as it was; once the budget is spent, the check answers null
 * without touching the database (the form's sign-in then shows the existing rate_limited message).
 */

const h = vi.hoisted(() => ({ ip: '203.0.113.77', dbCalls: 0, lockoutEmails: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': `${h.ip}, 10.0.0.1` }) }));
vi.mock('@/db', () => ({ getDbForAuth: async () => { h.dbCalls++; return { fake: true }; } }));
vi.mock('@/server/internal/login-attempts', () => ({
  getLockoutInfo: async (_db: unknown, email: string) => {
    h.lockoutEmails.push(email);
    return { isLocked: false, failedAttempts: 1, lockoutExpiresAt: null, minutesRemaining: 0 };
  },
}));

import { checkLockout } from '@/server/actions/login-attempts';
import { __resetForTests, consume } from '@/lib/rate-limit/store';
import { ipIdentifier } from '@/lib/rate-limit/identifier';

beforeEach(() => {
  __resetForTests();
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL']) vi.stubEnv(k, '');
  h.dbCalls = 0;
  h.lockoutEmails = [];
});

const signInFailure = () => consume('signInFailure', ipIdentifier(h.ip));

describe('A1-D6: checkLockout peeks at the sign-in failure budget', () => {
  it('allowed checks answer from the database and leave the budget unchanged (all 20 failures still available)', async () => {
    for (let i = 0; i < 30; i++) {
      expect(await checkLockout('jane@acme.test')).toMatchObject({ isLocked: false, failedAttempts: 1 });
    }
    expect(h.dbCalls).toBe(30);
    expect(h.lockoutEmails).toEqual(Array(30).fill('jane@acme.test'));
    for (let i = 0; i < 20; i++) expect((await signInFailure()).allowed, `failure ${i + 1}`).toBe(true);
    expect((await signInFailure()).allowed).toBe(false);
  });

  it('a spent budget → null, with no database read; it counts against the same IP the sign-in does (first XFF entry)', async () => {
    for (let i = 0; i < 20; i++) await signInFailure();
    expect(await checkLockout('jane@acme.test')).toBeNull();
    expect(h.dbCalls).toBe(0);
    h.ip = '203.0.113.78'; // another network still gets its answer
    expect(await checkLockout('jane@acme.test')).toMatchObject({ isLocked: false });
    expect(h.dbCalls).toBe(1);
    h.ip = '203.0.113.77';
  });
});
