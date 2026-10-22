import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-launch-blockers.md P1 §4–§5 / §9 "Emails": server-action sends are scheduled with `after()` and a
 * failing callback is caught; cron senders share a ≤ 2 sends/second budget.
 */

const afterTasks = vi.hoisted(() => [] as Array<() => Promise<unknown>>);
vi.mock('next/server', () => ({ after: (fn: () => Promise<unknown>) => { afterTasks.push(fn); } }));

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import { scheduleEmail } from '@/lib/email/schedule';
import { createSendThrottle, CRON_SEND_INTERVAL_MS } from '@/lib/email/rate';
import { getNoticeTimingForTests } from '@/lib/tenant/notices';

vi.mock('server-only', () => ({}));

beforeEach(() => {
  afterTasks.length = 0;
  sentry.captureException.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('scheduleEmail', () => {
  it('schedules the work with after() — nothing runs until the callback does', async () => {
    const work = vi.fn(async () => {});
    scheduleEmail('test', work);
    expect(afterTasks).toHaveLength(1);
    expect(work).not.toHaveBeenCalled();
    await afterTasks[0]();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('an after() callback that throws is caught and logged (never rejects)', async () => {
    scheduleEmail('boom', async () => { throw new Error('resend exploded'); });
    await expect(afterTasks[0]()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('createSendThrottle', () => {
  it('holds a cron sender to at most 2 sends per second (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const throttle = createSendThrottle();
    const starts: number[] = [];
    const run = (async () => {
      for (let i = 0; i < 6; i++) {
        await throttle();
        starts.push(Date.now());
      }
    })();
    await vi.runAllTimersAsync();
    await run;
    expect(starts).toHaveLength(6);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(CRON_SEND_INTERVAL_MS);
    }
    // Any 1-second window holds at most 2 sends.
    for (const t of starts) expect(starts.filter((s) => s >= t && s < t + 1000).length).toBeLessThanOrEqual(2);
  });

  it('does not sleep before the first send', async () => {
    const sleep = vi.fn(async () => {});
    const throttle = createSendThrottle(500, sleep, () => 1_000_000);
    await throttle();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('three concurrent cron senders stay ≤ 6/s, inside Resend’s 10/s team limit', () => {
    expect(3 * (1000 / CRON_SEND_INTERVAL_MS)).toBeLessThanOrEqual(6);
  });
});

describe('notice outbox throttle', () => {
  it('defaults to the shared 500 ms budget (≤ 2/s), not the old 125 ms', () => {
    expect(getNoticeTimingForTests().throttleMs).toBe(500);
  });
});
