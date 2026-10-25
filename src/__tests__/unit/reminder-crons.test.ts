import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { users, timesheetEntries, notificationPreferences, workspaceSettings, timesheetPeriods } from '@/db/schema';

/**
 * feature-plan-launch-blockers.md P6 §4 / §9 "Crons": the reminder crons skip SEED_EMAIL_DOMAINS recipients (demo
 * domains we don't own) but still remind a lifecycle-exempt REAL tenant (lifecycle_exempt can cover comped customers).
 * Audit A9: every send links to THAT tenant's host and is preceded by exactly one awaited throttle.
 * Audit A10: the budget is checked before every employee; a stop reports the last finished employee; a resumed tenant
 * queries employees after the saved one, in id order.
 */

type Tenant = { slug: string; status: string; lifecycleExempt: boolean; dbUrlEncrypted: string };
type Outcome = 'done' | { stoppedAfter: string | null };
const h = vi.hoisted(() => ({
  tenants: [] as Tenant[],
  employees: {} as Record<string, Array<{ id: string; fullName: string; email: string }>>,
  /** outOfTime() answers true from the Nth call on (Infinity = never out of time). */
  allowedChecks: Infinity,
  checks: 0,
  resumeAfter: {} as Record<string, string>,
  outcomes: [] as Outcome[],
  log: [] as string[],
  gtCalls: [] as unknown[][],
  daily: vi.fn(async (args: { employeeEmail: string; appUrl: string }) => { void args; return { ok: true as const, id: 'm' }; }),
  deadline: vi.fn(async (args: { employeeEmail: string; appUrl: string }) => { void args; return { ok: true as const, id: 'm' }; }),
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
      processTenant: (t: Tenant, ctx: { outOfTime: () => boolean; resumeAfter: string | null }) => Promise<Outcome>;
    }) => {
      for (const t of opts.tenants) {
        h.outcomes.push(await opts.processTenant(t, { outOfTime: () => h.checks++ >= h.allowedChecks, resumeAfter: h.resumeAfter[t.slug] ?? null }));
      }
      return { processed: opts.tenants.length, candidates: opts.tenants.length, failedTenants: [], incomplete: false, cursor: null, resumes: {} };
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
vi.mock('@/lib/email/send', () => ({ sendDailyReminderEmail: h.daily, sendSubmissionDeadlineEmail: h.deadline }));
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
          : table === timesheetEntries || table === notificationPreferences || table === timesheetPeriods ? []
          : (() => { throw new Error('unexpected table'); })();
        const whereResult = Object.assign(Promise.resolve(rows), { orderBy: async () => rows });
        return Object.assign(Promise.resolve(rows), { limit: async () => rows, where: () => whereResult });
      },
    }),
  }),
}));

import { GET as dailyReminder } from '@/app/api/cron/daily-reminder/route';
import { GET as submissionDeadline } from '@/app/api/cron/submission-deadline/route';

const req = (p: string) => new NextRequest(`https://app.example.com${p}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T20:00:00Z')); // a Wednesday in America/New_York
  h.daily.mockClear();
  h.deadline.mockClear();
  h.daily.mockImplementation(async (args) => { h.log.push(`send:${args.appUrl}`); return { ok: true as const, id: 'm' }; });
  h.deadline.mockImplementation(async (args) => { h.log.push(`send:${args.appUrl}`); return { ok: true as const, id: 'm' }; });
  h.allowedChecks = Infinity;
  h.checks = 0;
  h.resumeAfter = {};
  h.outcomes = [];
  h.log = [];
  h.gtCalls = [];
  h.tenants = [
    { slug: 'demo', status: 'active', lifecycleExempt: true, dbUrlEncrypted: 'db-demo' },
    { slug: 'comped', status: 'active', lifecycleExempt: true, dbUrlEncrypted: 'db-comped' },
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
  ['daily-reminder', () => dailyReminder(req('/api/cron/daily-reminder')), () => h.daily],
  ['submission-deadline', () => submissionDeadline(req('/api/cron/submission-deadline')), () => h.deadline],
] as const)('%s', (_name, run, sender) => {
  it('skips SEED_EMAIL_DOMAINS recipients; a lifecycle-exempt real tenant is still reminded', async () => {
    const res = await run();
    const body = await res.json();
    expect(sender().mock.calls.map(([a]) => a.employeeEmail)).toEqual(['real@comped-customer.com', 'second@comped-customer.com']);
    expect(body.skippedSeedRecipients).toBe(2);
    expect(body.sent).toBe(2);
  });

  it('audit A9: each send links to its own tenant host and is preceded by exactly one awaited throttle', async () => {
    h.employees['db-demo'] = [{ id: 'd3', fullName: 'Demo Real', email: 'person@demo-customer.com' }];
    await run();
    expect(h.log).toEqual([
      'throttle', 'send:https://demo.example.com',
      'throttle', 'send:https://comped.example.com',
      'throttle', 'send:https://comped.example.com',
    ]);
  });

  it('audit A10: out of time before the first employee → nothing sent, each tenant stops before any employee', async () => {
    h.allowedChecks = 0;
    await run();
    expect(sender()).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual([{ stoppedAfter: null }, { stoppedAfter: null }]);
  });

  it('audit A10: the budget is checked before every employee — a stop reports the last finished one', async () => {
    h.tenants = [h.tenants[1]]; // comped: c1, c2
    h.allowedChecks = 1; // c1 passes the check; out of time before c2
    await run();
    expect(sender().mock.calls.map(([a]) => a.employeeEmail)).toEqual(['real@comped-customer.com']);
    expect(h.outcomes).toEqual([{ stoppedAfter: 'c1' }]);
  });

  it('audit A10: a resumed tenant queries only employees after the saved one (id order)', async () => {
    h.tenants = [h.tenants[1]];
    h.resumeAfter = { comped: 'c1' };
    await run();
    expect(h.gtCalls).toEqual([[users.id, 'c1']]);
  });
});
