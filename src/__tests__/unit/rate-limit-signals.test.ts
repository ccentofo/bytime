import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-upstash-rate-limiting.md T12 (§6.6): the outage signal (once a minute per process, alert at 3 within an
 * hour, no per-signal Sentry event), the config alert, and their resolution by the notice-delivery cron.
 */

const h = vi.hoisted(() => ({
  afterTasks: [] as Array<() => Promise<unknown>>,
  signalCount: 1,
  lastSignal: null as Date | null,
  recordWindowedSignal: vi.fn(),
  raiseAlertWithEmail: vi.fn(),
  resolveAlert: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: (fn: () => Promise<unknown>) => { h.afterTasks.push(fn); } }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: h.captureMessage }));
vi.mock('@/lib/signup/signals', () => ({
  recordWindowedSignal: async (key: string, now: Date) => { h.recordWindowedSignal(key, now); return h.signalCount; },
  lastSignalAt: async () => h.lastSignal,
}));
vi.mock('@/lib/tenant/ops-alert-email', () => ({ raiseAlertWithEmail: async (...a: unknown[]) => { h.raiseAlertWithEmail(...a); return { opened: true, emailed: true }; } }));
vi.mock('@/lib/tenant/lifecycle-store', () => ({ resolveAlert: async (...a: unknown[]) => { h.resolveAlert(...a); } }));
vi.mock('@/db/control-plane/locked', () => ({ withLockedPool: async (fn: (db: unknown) => Promise<unknown>) => fn('db') }));

import { noteOutage, noteConfigMissing, resolveRateLimitSignals, __resetSignalThrottlesForTests } from '@/lib/rate-limit/signals';

async function flushAfter() {
  while (h.afterTasks.length) await h.afterTasks.shift()!();
}

const T0 = new Date('2026-11-13T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
  h.afterTasks.length = 0;
  h.signalCount = 1;
  h.lastSignal = null;
  for (const f of [h.recordWindowedSignal, h.raiseAlertWithEmail, h.resolveAlert, h.captureException, h.captureMessage]) f.mockReset();
  __resetSignalThrottlesForTests();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('noteOutage', () => {
  it('50 calls within a minute → 1 signal (after the response) and 0 Sentry events', async () => {
    for (let i = 0; i < 50; i++) noteOutage(new Error('x'), at(i * 1_000));
    expect(h.recordWindowedSignal).not.toHaveBeenCalled(); // scheduled with after(), not run inline
    await flushAfter();
    expect(h.recordWindowedSignal).toHaveBeenCalledTimes(1);
    expect(h.recordWindowedSignal).toHaveBeenCalledWith('rate-limit-outage', at(0));
    expect(h.captureException).not.toHaveBeenCalled();
    expect(h.captureMessage).not.toHaveBeenCalled();
  });

  it('a minute later it signals again', async () => {
    noteOutage(undefined, at(0));
    noteOutage(undefined, at(60_000));
    await flushAfter();
    expect(h.recordWindowedSignal).toHaveBeenCalledTimes(2);
  });

  it('the 3rd signal within an hour raises the rate-limit-outage email; the 2nd does not', async () => {
    h.signalCount = 2;
    noteOutage(undefined, at(0));
    await flushAfter();
    expect(h.raiseAlertWithEmail).not.toHaveBeenCalled();
    h.signalCount = 3;
    noteOutage(undefined, at(60_000));
    await flushAfter();
    expect(h.raiseAlertWithEmail).toHaveBeenCalledTimes(1);
    expect(h.raiseAlertWithEmail.mock.calls[0][0]).toMatchObject({
      tenantId: null,
      kind: 'rate-limit-outage',
      summary: 'Upstash rate limiting failed 3 times within an hour; sign-in and signup limits are falling back to per-instance memory.',
    });
  });

  it('a failing signal write is caught and logged by name (never the message)', async () => {
    h.recordWindowedSignal.mockImplementation(() => { throw Object.assign(new Error('postgres://u:pw@host'), { name: 'PostgresError' }); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    noteOutage(undefined, at(0));
    await expect(flushAfter()).resolves.toBeUndefined();
    expect(JSON.stringify(err.mock.calls)).toContain('PostgresError');
    expect(JSON.stringify(err.mock.calls)).not.toContain('pw@host');
    err.mockRestore();
  });
});

describe('noteConfigMissing', () => {
  it('raises rate-limit-config-missing naming what is missing, at most once an hour per process', async () => {
    noteConfigMissing(['UPSTASH_REDIS_REST_URL'], at(0));
    noteConfigMissing(['UPSTASH_REDIS_REST_URL'], at(30 * 60_000));
    await flushAfter();
    expect(h.raiseAlertWithEmail).toHaveBeenCalledTimes(1);
    expect(h.raiseAlertWithEmail.mock.calls[0][0]).toMatchObject({
      tenantId: null,
      kind: 'rate-limit-config-missing',
      detail: { missing: ['UPSTASH_REDIS_REST_URL'] },
      summary: "Rate limiting isn't configured on this deployment (UPSTASH_REDIS_REST_URL); sign-in and signup limits are per-instance memory only.",
    });
    noteConfigMissing(['UPSTASH_REDIS_REST_URL'], at(60 * 60_000));
    await flushAfter();
    expect(h.raiseAlertWithEmail).toHaveBeenCalledTimes(2);
  });
});

describe('resolveRateLimitSignals', () => {
  const resolvedKinds = () => h.resolveAlert.mock.calls.map((c) => (c[1] as { kind: string }).kind);
  const noConfig = () => { for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) vi.stubEnv(k, ''); };

  it('the last outage signal over an hour ago → rate-limit-outage resolved', async () => {
    noConfig();
    h.lastSignal = at(-61 * 60_000);
    await resolveRateLimitSignals(T0);
    expect(resolvedKinds()).toEqual(['rate-limit-outage']);
  });

  it('a signal under an hour ago → not resolved; config missing → not resolved', async () => {
    noConfig();
    h.lastSignal = at(-59 * 60_000);
    await resolveRateLimitSignals(T0);
    expect(resolvedKinds()).toEqual([]);
  });

  it('a valid configuration (the clients build) → rate-limit-config-missing resolved', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example-123.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok');
    vi.stubEnv('SIGNUP_IP_SALT', 'salt');
    h.lastSignal = at(-5 * 60_000);
    await resolveRateLimitSignals(T0);
    expect(resolvedKinds()).toEqual(['rate-limit-config-missing']);
  });

  it('an invalid URL does not resolve the config alert', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'rediss://default:secret@x');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok');
    vi.stubEnv('SIGNUP_IP_SALT', 'salt');
    h.lastSignal = at(-5 * 60_000);
    await resolveRateLimitSignals(T0);
    expect(resolvedKinds()).toEqual([]);
  });

  it('the notice-delivery cron calls it after resolveSignupSignals (static)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/api/cron/notice-delivery/route.ts'), 'utf8');
    expect(src).toContain("from '@/lib/rate-limit/signals'");
    expect(src.indexOf('await resolveRateLimitSignals(')).toBeGreaterThan(src.indexOf('await resolveSignupSignals()'));
  });
});
