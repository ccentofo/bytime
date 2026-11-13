import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { users, timesheetEntries, notificationPreferences, workspaceSettings, timesheetPeriods } from '@/db/schema';
import type { ReminderMessage } from '@/lib/email/reminder-messages';
import type { BatchOutcome } from '@/lib/email/send-batch';
import type { CronStopReason } from '@/lib/cron/tenant-sweep';

/**
 * feature-plan-launch-blockers.md P6 §4 / §9 "Crons": the reminder crons skip SEED_EMAIL_DOMAINS recipients (demo
 * domains we don't own) but still remind a lifecycle-exempt REAL tenant (lifecycle_exempt can cover comped customers).
 * Audit A9: every batch links to THAT tenant's host and is preceded by exactly one awaited throttle.
 * Audit A10: the budget is checked before every employee; a stop reports the last finished employee; a resumed tenant
 * queries employees after the saved one, in id order.
 * feature-plan-reminder-capacity.md §11 C1–C14: reminders go out in batches of up to 100, one workspace per batch,
 * with the §6.3 key and the sweep's sendCutoff; email stops keep the run's starting position; the run-level breaker.
 *
 * Harness (impact analysis §5): the sweep is mocked. It breaks on the first non-'done' outcome (as the real sweep does,
 * pinned in cron-ops.test.ts), passes a fixed sendCutoff, and returns stopReason. deliverReminderBatch is replaced;
 * REMINDER_BATCH_SIZE and reminderBatchKey stay real.
 */

type Tenant = { id: string; slug: string; status: string; lifecycleExempt: boolean; dbUrlEncrypted: string };
type Outcome = 'done' | { stoppedAfter: string | null; reason?: CronStopReason };
type Employee = { id: string; fullName: string; email: string };
type BatchOpts = { idempotencyKey: string; notAfter: number };
const SEND_CUTOFF = 1_234_567;

const h = vi.hoisted(() => ({
  tenants: [] as Tenant[],
  employees: {} as Record<string, Employee[]>,
  /** outOfTime() answers true from the Nth call on (Infinity = never out of time). */
  allowedChecks: Infinity,
  checks: 0,
  resumeAfter: {} as Record<string, string>,
  outcomes: [] as Outcome[],
  log: [] as string[],
  gtCalls: [] as unknown[][],
  /** H1: rows the notification_preferences table answers with (the old opt-out column included). */
  prefRows: [] as Array<Record<string, unknown>>,
  /** H1 / T2: when set, any notification_preferences query throws (the deadline cron still reads it, so per test). */
  throwOnPrefs: false,
  /** Outcomes the batch helper returns, in order; when empty, every message is sent. */
  batchQueue: [] as BatchOutcome[],
  batch: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', async (importOriginal) => {
  const real = await importOriginal<typeof import('drizzle-orm')>();
  return { ...real, gt: (...args: Parameters<typeof real.gt>) => { h.gtCalls.push(args); return real.gt(...args); } };
});
vi.mock('@/lib/cron/run-cron', () => ({
  runCron: async (_req: unknown, _name: string, work: () => Promise<Record<string, unknown>>) => Response.json(await work()),
}));
vi.mock('@/lib/cron/tenant-sweep', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cron/tenant-sweep')>();
  return {
    ...real,
    sweepTenants: async (opts: {
      tenants: Tenant[];
      processTenant: (t: Tenant, ctx: { outOfTime: () => boolean; resumeAfter: string | null; sendCutoff: number }) => Promise<Outcome>;
    }) => {
      let processed = 0;
      let stopReason: string | null = null;
      for (const t of opts.tenants) {
        const outcome = await opts.processTenant(t, {
          outOfTime: () => h.checks++ >= h.allowedChecks, resumeAfter: h.resumeAfter[t.slug] ?? null, sendCutoff: SEND_CUTOFF,
        });
        h.outcomes.push(outcome);
        h.log.push(`return:${t.slug}`);
        if (outcome !== 'done') { stopReason = outcome.reason ?? 'budget'; break; } // as the real sweep (tenant-sweep.ts:84-90)
        processed++;
      }
      return { processed, candidates: opts.tenants.length, failedTenants: [], incomplete: stopReason !== null, cursor: null, resumes: {}, stopReason };
    },
  };
});
vi.mock('@/db/control-plane', () => ({
  controlDb: { select: () => ({ from: () => ({ where: async () => h.tenants }) }) },
}));
vi.mock('@/lib/tenant/registry', () => ({ toLifecycleFacts: (t: unknown) => t }));
vi.mock('@/lib/tenant/lifecycle', () => ({ getTenantAccess: () => 'full' }));
vi.mock('@/lib/encryption', () => ({ decrypt: (s: string) => s }));
vi.mock('@/lib/email/rate', () => ({ createSendThrottle: () => async () => { h.log.push('throttle'); } }));
vi.mock('@/lib/email/send-batch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/send-batch')>()),
  deliverReminderBatch: h.batch,
}));
vi.mock('@/lib/tenant/host', () => ({ tenantBaseUrl: (s: string) => `https://${s}.example.com` }));
vi.mock('@/server/internal/pay-period-config', () => ({ configAt: async () => ({}) }));
vi.mock('@/lib/date-utils', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/date-utils')>();
  // Deadline today (daysUntilDeadline 0) so the submission-deadline cron sends.
  return { ...real, getCurrentPeriodStart: (today: string) => today, getNumDaysInPeriod: () => 14, getLastWeekdayInPeriod: (start: string) => start };
});
vi.mock('@/db', () => ({
  getDbForUrl: (url: string) => ({
    select: () => ({
      from: (table: unknown) => {
        const rows = table === workspaceSettings ? [{ timezone: 'America/New_York' }]
          : table === users ? h.employees[url] ?? []
          : table === notificationPreferences ? (h.throwOnPrefs ? (() => { throw new Error('notification_preferences queried'); })() : h.prefRows)
          : table === timesheetEntries || table === timesheetPeriods ? []
          : (() => { throw new Error('unexpected table'); })();
        const whereResult = Object.assign(Promise.resolve(rows), { orderBy: async () => rows });
        return Object.assign(Promise.resolve(rows), { limit: async () => rows, where: () => whereResult });
      },
    }),
  }),
}));

import { GET as dailyReminder } from '@/app/api/cron/daily-reminder/route';
import { GET as submissionDeadline } from '@/app/api/cron/submission-deadline/route';
import { reminderBatchKey } from '@/lib/email/send-batch';

const req = (p: string) => new NextRequest(`https://app.example.com${p}`);
const appUrlOf = (m: ReminderMessage) => (m.react.props as { appUrl: string }).appUrl;
const batches = () => h.batch.mock.calls.map((c) => c[1] as ReminderMessage[]);
const batchOpts = () => h.batch.mock.calls.map((c) => c[2] as BatchOpts);
const sentTo = () => batches().flat().map((m) => m.to);
const people = (prefix: string, n: number, domain = 'customer.com'): Employee[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(3, '0')}`, fullName: `P ${i}`, email: `${prefix}${i}@${domain}` }));
const tenant = (slug: string, n: number): Tenant => ({ id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, slug, status: 'active', lifecycleExempt: false, dbUrlEncrypted: `db-${slug}` });
const failed = (n: number, errorName = 'validation_error'): BatchOutcome => ({ kind: 'failed', failed: n, errorName });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T20:00:00Z')); // a Wednesday in America/New_York
  h.batch.mockReset();
  h.batch.mockImplementation(async (_label: string, messages: ReminderMessage[]) => {
    h.log.push(`batch(${new URL(appUrlOf(messages[0])).hostname.split('.')[0]}×${messages.length})`);
    return h.batchQueue.shift() ?? { kind: 'sent', sent: messages.length, failed: 0 };
  });
  h.batchQueue = [];
  h.allowedChecks = Infinity;
  h.checks = 0;
  h.resumeAfter = {};
  h.outcomes = [];
  h.log = [];
  h.gtCalls = [];
  h.prefRows = [];
  h.throwOnPrefs = false;
  h.tenants = [
    { id: '00000000-0000-4000-8000-0000000000d1', slug: 'demo', status: 'active', lifecycleExempt: true, dbUrlEncrypted: 'db-demo' },
    { id: '00000000-0000-4000-8000-0000000000c1', slug: 'comped', status: 'active', lifecycleExempt: true, dbUrlEncrypted: 'db-comped' },
  ];
  h.employees = {
    'db-demo': [{ id: 'd1', fullName: 'Demo Jane', email: 'jane@cadenzpoint.dev' }, { id: 'd2', fullName: 'Demo Joe', email: 'joe@bytime.dev' }],
    'db-comped': [
      { id: 'c1', fullName: 'Real Person', email: 'real@comped-customer.com' },
      { id: 'c2', fullName: 'Second Person', email: 'second@comped-customer.com' },
    ],
  };
});
afterEach(() => { vi.useRealTimers(); });

describe.each([
  ['daily-reminder', () => dailyReminder(req('/api/cron/daily-reminder'))],
  ['submission-deadline', () => submissionDeadline(req('/api/cron/submission-deadline'))],
] as const)('%s', (cron, run) => {
  const body = async () => (await run()).json() as Promise<Record<string, unknown>>;

  it('C1: skips SEED_EMAIL_DOMAINS recipients; a lifecycle-exempt real tenant is still reminded', async () => {
    const b = await body();
    expect(sentTo()).toEqual(['real@comped-customer.com', 'second@comped-customer.com']);
    expect(b.skippedSeedRecipients).toBe(2);
    expect(b.sent).toBe(2);
  });

  it('C2 (audit A9): one throttle per batch; each batch is one tenant, linking to its own host', async () => {
    h.employees['db-demo'] = [{ id: 'd3', fullName: 'Demo Real', email: 'person@demo-customer.com' }];
    await run();
    expect(h.log).toEqual(['throttle', 'batch(demo×1)', 'return:demo', 'throttle', 'batch(comped×2)', 'return:comped']);
    const [demo, comped] = batches();
    expect(demo.map(appUrlOf)).toEqual(['https://demo.example.com']);
    expect(comped.map(appUrlOf)).toEqual(['https://comped.example.com', 'https://comped.example.com']);
    for (const b of batches()) expect(new Set(b.map(appUrlOf)).size).toBe(1);
  });

  it('C3: 250 eligible employees in one tenant → batches of 100, 100, 50 in id order; 3 throttles', async () => {
    h.tenants = [h.tenants[1]];
    h.employees['db-comped'] = people('u', 250);
    const b = await body();
    expect(batches().map((x) => x.length)).toEqual([100, 100, 50]);
    expect(sentTo()).toEqual(people('u', 250).map((p) => p.email));
    expect(h.log.filter((l) => l === 'throttle')).toHaveLength(3);
    expect(b.batches).toBe(3);
    expect(b.sent).toBe(250);
  });

  it('C4 (audit A10): out of time before the first employee → no batch; the sweep stops after the first tenant', async () => {
    h.allowedChecks = 0;
    const b = await body();
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual([{ stoppedAfter: null }]);
    expect(b.stopReason).toBe('budget');
  });

  it('C5 (audit A10): out of time after c1 → c1 is sent in a batch of 1 before the tenant returns', async () => {
    h.tenants = [h.tenants[1]];
    h.allowedChecks = 1; // c1 passes the check; out of time before c2
    await run();
    expect(sentTo()).toEqual(['real@comped-customer.com']);
    expect(h.log).toEqual(['throttle', 'batch(comped×1)', 'return:comped']);
    expect(h.outcomes).toEqual([{ stoppedAfter: 'c1' }]);
  });

  it('C6 (audit A10): a resumed tenant queries only employees after the saved one (id order)', async () => {
    h.tenants = [h.tenants[1]];
    h.resumeAfter = { comped: 'c1' };
    await run();
    expect(h.gtCalls).toEqual([[users.id, 'c1']]);
  });

  it('C7: an email-quota stop in tenant 1 → no further batch; the resume point is unchanged (r0)', async () => {
    h.tenants = [h.tenants[1], tenant('zeta', 3)];
    h.employees['db-zeta'] = people('z', 2);
    h.resumeAfter = { comped: 'r0' };
    h.batchQueue = [{ kind: 'stop', failed: 2, reason: 'email-quota' }];
    const b = await body();
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(h.outcomes).toEqual([{ stoppedAfter: 'r0', reason: 'email-quota' }]);
    expect(b.stopReason).toBe('email-quota');
    expect(b.failedSends).toBe(2);
  });

  it('C8: no saved resume; batch 2 stops (email-config) → stoppedAfter null, not employee 100 or the seed employee', async () => {
    h.tenants = [h.tenants[1]];
    h.employees['db-comped'] = [...people('u', 100), { id: 'u100', fullName: 'Seed', email: 'seed@cadenzpoint.dev' }, { id: 'u101', fullName: 'Last', email: 'last@customer.com' }];
    h.batchQueue = [{ kind: 'sent', sent: 100, failed: 0 }, { kind: 'stop', failed: 1, reason: 'email-config' }];
    const b = await body();
    expect(batches().map((x) => x.length)).toEqual([100, 1]);
    expect(h.outcomes).toEqual([{ stoppedAfter: null, reason: 'email-config' }]);
    expect(b.sent).toBe(100);
    expect(b.stopReason).toBe('email-config');
  });

  it('C8 (full batch): the first batch of 100 stops (email-quota) mid-tenant → stoppedAfter null, not employee 100; no second batch', async () => {
    h.tenants = [h.tenants[1]];
    h.employees['db-comped'] = people('u', 150);
    h.batchQueue = [{ kind: 'stop', failed: 100, reason: 'email-quota' }];
    const b = await body();
    expect(batches().map((x) => x.length)).toEqual([100]);
    expect(h.outcomes).toEqual([{ stoppedAfter: null, reason: 'email-quota' }]);
    expect(b).toMatchObject({ sent: 0, failedSends: 100, stopReason: 'email-quota' });
  });

  it('C9: tenant 1\'s batch fails → failedSends counts it; tenant 2 is still sent', async () => {
    h.employees['db-demo'] = [{ id: 'd3', fullName: 'Demo Real', email: 'person@demo-customer.com' }];
    h.batchQueue = [failed(1)];
    const b = await body();
    expect(h.batch).toHaveBeenCalledTimes(2);
    expect(b).toMatchObject({ sent: 2, failedSends: 1, batches: 2, stopReason: null });
  });

  it('C10: the helper returns disabled → nothing counted, no batches, the run completes', async () => {
    h.employees['db-demo'] = [{ id: 'd3', fullName: 'Demo Real', email: 'person@demo-customer.com' }];
    h.batch.mockImplementation(async () => ({ kind: 'disabled' }));
    const b = await body();
    expect(b).toMatchObject({ sent: 0, failedSends: 0, batches: 0, incomplete: false, stopReason: null });
    expect(h.outcomes).toEqual(['done', 'done']);
  });

  it('C11: totals across two tenants, one partial (2 of 3 sent)', async () => {
    h.employees['db-demo'] = people('d', 3, 'demo-customer.com');
    h.batchQueue = [{ kind: 'sent', sent: 2, failed: 1 }];
    const b = await body();
    expect(b).toMatchObject({ sent: 2 + 2, failedSends: 1, batches: 2 });
  });

  it('C12: the idempotency key and notAfter passed to the helper', async () => {
    h.tenants = [h.tenants[1]];
    await run();
    expect(h.batch.mock.calls[0][0]).toBe(cron);
    expect(batchOpts()).toEqual([{
      idempotencyKey: reminderBatchKey(cron, '00000000-0000-4000-8000-0000000000c1', '2026-10-21', ['c1', 'c2']),
      notAfter: SEND_CUTOFF,
    }]);
  });

  it('C13: resumed after r0, out of time with a batch queued, and that flush stops (email-quota) → r0, not lastDone', async () => {
    h.tenants = [h.tenants[1]];
    h.resumeAfter = { comped: 'r0' };
    h.allowedChecks = 1; // c1 queued; out of time before c2
    h.batchQueue = [{ kind: 'stop', failed: 1, reason: 'email-quota' }];
    const b = await body();
    expect(h.outcomes).toEqual([{ stoppedAfter: 'r0', reason: 'email-quota' }]);
    expect(b.stopReason).toBe('email-quota');
  });

  describe('C14: the run-level breaker', () => {
    const fourTenants = () => {
      h.tenants = [tenant('t1', 1), tenant('t2', 2), tenant('t3', 3), tenant('t4', 4)];
      for (const t of h.tenants) h.employees[t.dbUrlEncrypted] = people(t.slug, 1);
    };

    it('(a) three failed batches in a row (three tenants) → email-failing; the fourth tenant is not processed', async () => {
      fourTenants();
      h.batchQueue = [failed(1), failed(1), failed(1)];
      const b = await body();
      expect(h.batch).toHaveBeenCalledTimes(3);
      expect(h.outcomes).toEqual(['done', 'done', { stoppedAfter: null, reason: 'email-failing' }]);
      expect(b.stopReason).toBe('email-failing');
    });

    it('(b) failed, sent (with ids), failed, failed → no stop', async () => {
      fourTenants();
      h.batchQueue = [failed(1), { kind: 'sent', sent: 1, failed: 0 }, failed(1), failed(1)];
      const b = await body();
      expect(h.batch).toHaveBeenCalledTimes(4);
      expect(b.stopReason).toBeNull();
    });

    it('(c) failed, sent with sent 0, failed → stop (a zero-sent batch counts)', async () => {
      fourTenants();
      h.batchQueue = [failed(1), { kind: 'sent', sent: 0, failed: 1 }, failed(1)];
      const b = await body();
      expect(h.batch).toHaveBeenCalledTimes(3);
      expect(b.stopReason).toBe('email-failing');
    });

    it('(d) failed, disabled, failed, failed → stop (disabled does not reset)', async () => {
      fourTenants();
      h.batchQueue = [failed(1), { kind: 'disabled' }, failed(1), failed(1)];
      const b = await body();
      expect(h.batch).toHaveBeenCalledTimes(4);
      expect(h.outcomes[3]).toEqual({ stoppedAfter: null, reason: 'email-failing' });
      expect(b.stopReason).toBe('email-failing');
    });

    it('(e) three concurrent_idempotent_requests failures → no stop', async () => {
      fourTenants();
      h.batchQueue = [failed(1, 'concurrent_idempotent_requests'), failed(1, 'concurrent_idempotent_requests'), failed(1, 'concurrent_idempotent_requests')];
      const b = await body();
      expect(h.batch).toHaveBeenCalledTimes(4);
      expect(b.stopReason).toBeNull();
    });
  });
});

/**
 * feature-plan-launch-hardening.md H1 (§4.3): employees can't opt out of the daily reminder — the cron no longer reads
 * notification_preferences at all.
 */
describe('daily-reminder: always on (H1)', () => {
  it('T1: an employee whose preference row says email_daily_reminder = false, with no entry today, is sent the reminder', async () => {
    h.tenants = [h.tenants[1]];
    h.employees['db-comped'] = [{ id: 'c1', fullName: 'Real Person', email: 'real@comped-customer.com' }];
    h.prefRows = [{ enabled: false, emailDailyReminder: false, emailDeadlineReminder: true, userId: 'c1' }];
    const body = await (await dailyReminder(req('/api/cron/daily-reminder'))).json();
    expect(sentTo()).toEqual(['real@comped-customer.com']);
    expect(body.sent).toBe(1);
  });

  it('T2: no notification_preferences query runs (and the employee is still sent the reminder)', async () => {
    h.tenants = [h.tenants[1]];
    h.employees['db-comped'] = [{ id: 'c1', fullName: 'Real Person', email: 'real@comped-customer.com' }];
    h.throwOnPrefs = true;
    const body = await (await dailyReminder(req('/api/cron/daily-reminder'))).json();
    // Positive check: the sweep would swallow the throw, so a missing send is how a lookup would show.
    expect(sentTo()).toEqual(['real@comped-customer.com']);
    expect(body.sent).toBe(1);
  });
});
