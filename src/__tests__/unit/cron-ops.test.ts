import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

/**
 * feature-plan-launch-blockers.md P6 / §9 "Heartbeat" and "Crons": cron_runs heartbeat, staleness per cron, the
 * `?probe=1` smoke probe, optional Sentry monitors, the reminder crons' fair rotation + time budget + incomplete alert,
 * per-tenant failure reporting, and the immediate-email alert.
 */

const h = vi.hoisted(() => ({
  calls: [] as string[],
  cursor: null as string | null,
  alertsWithEmail: [] as Array<Record<string, unknown>>,
  resolved: [] as Array<Record<string, unknown>>,
  sentry: { messages: [] as string[], exceptions: [] as Array<{ err: unknown; ctx: unknown }>, monitors: [] as Array<{ slug: string; config: unknown }>, flushes: [] as unknown[] },
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({
  captureMessage: (m: string) => { h.sentry.messages.push(m); },
  captureException: (err: unknown, ctx?: unknown) => { h.sentry.exceptions.push({ err, ctx }); },
  withMonitor: (slug: string, cb: () => unknown, config: unknown) => { h.sentry.monitors.push({ slug, config }); return cb(); },
  flush: async (t: unknown) => { h.sentry.flushes.push(t); return true; },
}));
vi.mock('@/lib/rate-limit', () => ({ checkCronRateLimit: () => null }));
vi.mock('@/db/control-plane', () => ({ controlDb: {} }));
vi.mock('@/db/control-plane/locked', () => ({ withLockedPool: async (fn: (db: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/tenant/lifecycle-store', () => ({
  resolveAlert: async (_db: unknown, alert: Record<string, unknown>) => { h.resolved.push(alert); },
  raiseAlert: async () => ({ opened: true }),
}));
vi.mock('@/lib/tenant/ops-alert-email', () => ({
  raiseAlertWithEmail: async (a: Record<string, unknown>) => { h.alertsWithEmail.push(a); return { opened: true, emailed: true }; },
}));
vi.mock('@/lib/cron/heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cron/heartbeat')>()),
  recordCronStart: async (name: string) => { h.calls.push(`start:${name}`); },
  recordCronSuccess: async (name: string, summary: Record<string, unknown>) => { h.calls.push(`success:${name}:${JSON.stringify(summary)}`); },
  readCronCursor: async () => h.cursor,
}));

import { CRON_NAMES, CRON_SCHEDULES, cronProblems, type CronRunRow } from '@/lib/cron/heartbeat';
import { runCron } from '@/lib/cron/run-cron';
import { rotateAfterCursor, isSeedRecipient, sweepTenants } from '@/lib/cron/tenant-sweep';

const ROOT = path.resolve(__dirname, '../../..');
const HOUR = 3_600_000;

beforeEach(() => {
  h.calls = [];
  h.cursor = null;
  h.alertsWithEmail = [];
  h.resolved = [];
  h.sentry = { messages: [], exceptions: [], monitors: [], flushes: [] };
  delete process.env.SENTRY_CRON_MONITORS;
  process.env.CRON_SECRET = 'test-cron-secret';
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.SENTRY_CRON_MONITORS;
});

const cronRequest = (pathAndQuery: string, secret: string | null = 'test-cron-secret') =>
  new NextRequest(`https://app.example.com${pathAndQuery}`, { headers: secret ? { 'x-cron-secret': secret } : {} });

describe('heartbeat staleness (digest)', () => {
  const fresh = (now: Date): CronRunRow[] => CRON_NAMES.map((name) => ({ name, lastStartedAt: now, lastSucceededAt: new Date(now.getTime() - 10 * 60_000), lastSummary: {} }));

  it('nothing listed when every cron succeeded within its limit', () => {
    const now = new Date('2026-10-21T13:00:00Z');
    expect(cronProblems(fresh(now), now)).toEqual([]);
  });

  it('each cron is judged by its own limit', () => {
    const now = new Date('2026-10-21T13:00:00Z'); // a Wednesday
    const rows = fresh(now).map((r) => r.name === 'notice-delivery' ? { ...r, lastSucceededAt: new Date(now.getTime() - 2 * HOUR) }
      : r.name === 'submission-deadline' ? { ...r, lastSucceededAt: new Date(now.getTime() - 27 * HOUR) } : r);
    expect(cronProblems(rows, now).map((p) => [p.name, p.problem, p.limitHours])).toEqual([
      ['notice-delivery', 'stale', 1], ['submission-deadline', 'stale', 26],
    ]);
  });

  it('daily-reminder is not flagged on Monday (last run Friday 20:00), but is after 74 h', () => {
    const monday = new Date('2026-10-26T13:00:00Z');
    const friday20 = new Date('2026-10-23T20:00:00Z');
    const rows = fresh(monday).map((r) => r.name === 'daily-reminder' ? { ...r, lastSucceededAt: friday20 } : r);
    expect(cronProblems(rows, monday)).toEqual([]);
    const tuesdayLate = new Date(friday20.getTime() + 75 * HOUR);
    expect(cronProblems(rows.map((r) => r.name === 'daily-reminder' ? r : { ...r, lastSucceededAt: tuesdayLate }), tuesdayLate)
      .map((p) => p.name)).toEqual(['daily-reminder']);
  });

  it('a cron with no cron_runs row is listed as never ran', () => {
    const now = new Date('2026-10-21T13:00:00Z');
    const problems = cronProblems(fresh(now).filter((r) => r.name !== 'tenant-lifecycle'), now);
    expect(problems).toEqual([{ name: 'tenant-lifecycle', problem: 'never-ran', lastSucceededAt: null, limitHours: 26 }]);
  });

  it('CRON_SCHEDULES matches vercel.json', () => {
    const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
    expect(Object.fromEntries(vercel.crons.map((c) => [c.path.replace('/api/cron/', ''), c.schedule]))).toEqual(CRON_SCHEDULES);
  });
});

describe('runCron', () => {
  it('writes cron_runs start, runs the work, writes success with the summary', async () => {
    const res = await runCron(cronRequest('/api/cron/daily-reminder'), 'daily-reminder', async () => {
      h.calls.push('work');
      return { sent: 3, cursor: 'acme' };
    }, { maxRuntimeMinutes: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 3, cursor: 'acme' });
    expect(h.calls).toEqual(['start:daily-reminder', 'work', 'success:daily-reminder:{"sent":3,"cursor":"acme"}']);
  });

  it('?probe=1 → 200 {"probe":"ok"}: no work, no cron_runs write, no monitor (even with monitors on)', async () => {
    process.env.SENTRY_CRON_MONITORS = '1';
    const work = vi.fn(async () => ({}));
    const res = await runCron(cronRequest('/api/cron/daily-reminder?probe=1'), 'daily-reminder', work, { maxRuntimeMinutes: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ probe: 'ok' });
    expect(work).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.sentry.monitors).toEqual([]);
  });

  it('the probe is answered only after auth (shared cron auth → 401)', async () => {
    const work = vi.fn(async () => ({}));
    const res = await runCron(cronRequest('/api/cron/daily-reminder?probe=1', null), 'daily-reminder', work, { maxRuntimeMinutes: 5 });
    expect(res.status).toBe(401);
    expect(work).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it('a failed run records the start but not a success (so the digest flags it)', async () => {
    await expect(runCron(cronRequest('/api/cron/submission-deadline'), 'submission-deadline', async () => { throw new Error('boom'); }, { maxRuntimeMinutes: 5 }))
      .rejects.toThrow('boom');
    expect(h.calls).toEqual(['start:submission-deadline']);
  });

  it('SENTRY_CRON_MONITORS=1 wraps the run in withMonitor (schedule from vercel.json) and flushes', async () => {
    process.env.SENTRY_CRON_MONITORS = '1';
    await runCron(cronRequest('/api/cron/tenant-lifecycle'), 'tenant-lifecycle', async () => ({ ok: true }), { maxRuntimeMinutes: 14 });
    expect(h.sentry.monitors).toEqual([{ slug: 'tenant-lifecycle', config: expect.objectContaining({ schedule: { type: 'crontab', value: '0 13 * * *' }, maxRuntime: 14 }) }]);
    expect(h.sentry.flushes).toEqual([2000]);
  });

  it('monitors off (default, LB-D7) → no withMonitor, no flush', async () => {
    await runCron(cronRequest('/api/cron/tenant-lifecycle'), 'tenant-lifecycle', async () => ({ ok: true }), { maxRuntimeMinutes: 14 });
    expect(h.sentry.monitors).toEqual([]);
    expect(h.sentry.flushes).toEqual([]);
  });

  it('every cron route goes through runCron with its own name', () => {
    for (const name of CRON_NAMES) {
      const src = readFileSync(path.join(ROOT, `src/app/api/cron/${name}/route.ts`), 'utf8');
      expect(src, name).toMatch(new RegExp(`runCron\\(request, '${name}'`));
      expect(src, name).not.toMatch(/rejectUnauthorizedCron|checkCronRateLimit/); // auth only via runCron
    }
  });
});

describe('reminder sweep: fair rotation + time budget', () => {
  const T = (slug: string) => ({ slug });

  it('rotateAfterCursor starts after the saved slug and wraps', () => {
    const list = [T('delta'), T('alpha'), T('charlie'), T('bravo')];
    expect(rotateAfterCursor(list, null).map((t) => t.slug)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    expect(rotateAfterCursor(list, 'bravo').map((t) => t.slug)).toEqual(['charlie', 'delta', 'alpha', 'bravo']);
    expect(rotateAfterCursor(list, 'delta').map((t) => t.slug)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    expect(rotateAfterCursor(list, 'bz').map((t) => t.slug)).toEqual(['charlie', 'delta', 'alpha', 'bravo']); // cursor tenant gone
  });

  it('a budget stop → incomplete + Sentry message + cron-incomplete alert; the next run serves the starved tenant first', async () => {
    let now = 0;
    const order: string[] = [];
    const first = await sweepTenants({
      name: 'daily-reminder', tenants: [T('a'), T('b'), T('c'), T('d')], budgetMs: 100, clock: () => now,
      processTenant: async (t) => { order.push(t.slug); now += 60; return 'done'; },
    });
    expect(order).toEqual(['a', 'b']); // a: 0→60, b: 60→120, then out of time
    expect(first).toMatchObject({ incomplete: true, processed: 2, cursor: 'b' });
    expect(h.sentry.messages).toEqual(['cron daily-reminder stopped at its time budget']);
    expect(h.alertsWithEmail).toEqual([expect.objectContaining({ kind: 'cron-incomplete', dedupKey: 'daily-reminder', tenantId: null })]);

    // Next run: the saved cursor ('b') → 'c' (starved last time) is served first.
    h.cursor = first.cursor;
    now = 0;
    order.length = 0;
    const second = await sweepTenants({
      name: 'daily-reminder', tenants: [T('a'), T('b'), T('c'), T('d')], budgetMs: 10_000, clock: () => now,
      processTenant: async (t) => { order.push(t.slug); return 'done'; },
    });
    expect(order).toEqual(['c', 'd', 'a', 'b']);
    expect(second.incomplete).toBe(false);
    expect(h.resolved).toEqual([expect.objectContaining({ kind: 'cron-incomplete', dedupKey: 'daily-reminder' })]); // resolved by a complete run
  });

  it('a tenant that runs out of time part-way is not counted as processed (cursor stays before it)', async () => {
    const r = await sweepTenants({
      name: 'submission-deadline', tenants: [T('a'), T('b')], budgetMs: 10_000,
      processTenant: async (t) => (t.slug === 'b' ? 'stopped' : 'done'),
    });
    expect(r).toMatchObject({ incomplete: true, processed: 1, cursor: 'a' });
  });

  it('a per-tenant failure → Sentry (tenant tag), counted, and the other tenants still run', async () => {
    const order: string[] = [];
    const boom = new Error('tenant db unreachable');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await sweepTenants({
      name: 'daily-reminder', tenants: [T('a'), T('b'), T('c')], budgetMs: 10_000,
      processTenant: async (t) => { order.push(t.slug); if (t.slug === 'b') throw boom; return 'done'; },
    });
    spy.mockRestore();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(r.failedTenants).toEqual(['b']);
    expect(h.sentry.exceptions).toEqual([{ err: boom, ctx: { tags: { tenant: 'b', cron: 'daily-reminder' } } }]);
    expect(r.incomplete).toBe(false);
  });

  it('SEED_EMAIL_DOMAINS recipients are recognised (demo domains we do not own)', () => {
    expect(isSeedRecipient('jane@cadenzpoint.dev')).toBe(true);
    expect(isSeedRecipient('JOHN@ByTime.Dev')).toBe(true);
    expect(isSeedRecipient('ops@cadenzpoint.com')).toBe(false);
    expect(isSeedRecipient('person@customer.com')).toBe(false);
  });
});
