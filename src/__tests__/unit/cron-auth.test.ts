import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Launch-blockers audit R12: rejectUnauthorizedCron checks CRON_SECRET first (constant-time, length-checked); only
 * failed attempts count toward — and are refused by — the cron rate limit (2/min/IP). A correct secret is never
 * rate-limited: three crons at 20:00 UTC from one instance all run. Uses the real in-memory rate limiter; each test
 * uses its own IP so the shared store doesn't leak between tests.
 */

vi.mock('server-only', () => ({}));

import { rejectUnauthorizedCron } from '@/lib/cron-auth';

const SECRET = 'test-cron-secret-0123456789';
let ipSeq = 0;
let ip = '';

const call = (headers: Record<string, string> = {}) =>
  rejectUnauthorizedCron(new NextRequest('https://app.example.com/api/cron/daily-reminder?probe=1', { headers: { 'x-forwarded-for': ip, ...headers } }));
const status = (r: Response | null) => (r === null ? 'allowed' : r.status);

beforeEach(() => {
  ip = `198.51.100.${++ipSeq}`;
  vi.stubEnv('CRON_SECRET', SECRET);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('rejectUnauthorizedCron (audit R12)', () => {
  it('5 authorized calls in a row from one IP all pass (x-cron-secret and Bearer)', () => {
    const results = [
      call({ 'x-cron-secret': SECRET }), call({ 'x-cron-secret': SECRET }), call({ authorization: `Bearer ${SECRET}` }),
      call({ 'x-cron-secret': SECRET }), call({ authorization: `Bearer ${SECRET}` }),
    ];
    expect(results.map(status)).toEqual(['allowed', 'allowed', 'allowed', 'allowed', 'allowed']);
  });

  it('3 wrong-secret calls → 401, 401, then 429; a correct call after that still passes', async () => {
    const wrong = [call({ 'x-cron-secret': 'nope' }), call({}), call({ 'x-cron-secret': `${SECRET}x` })];
    expect(wrong.map(status)).toEqual([401, 401, 429]);
    expect(await wrong[0]!.json()).toEqual({ error: 'Unauthorized' });
    expect(status(call({ 'x-cron-secret': SECRET }))).toBe('allowed');
    expect(status(call({ 'x-cron-secret': 'nope' }))).toBe(429); // failures stay limited
  });

  it('a secret of a different length, or a same-length wrong one, is refused (no throw from timingSafeEqual)', () => {
    expect(status(call({ 'x-cron-secret': SECRET.slice(0, -1) }))).toBe(401);
    expect(status(call({ 'x-cron-secret': SECRET.replace(/.$/, 'X') }))).toBe(401);
  });

  it('production without CRON_SECRET is fail-closed (and those attempts are rate-limited)', () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect([call({ 'x-cron-secret': 'anything' }), call({}), call({})].map(status)).toEqual([401, 401, 429]);
  });

  it('local dev without CRON_SECRET is open (unchanged)', () => {
    vi.stubEnv('CRON_SECRET', '');
    expect([call(), call(), call()].map(status)).toEqual(['allowed', 'allowed', 'allowed']);
  });
});
