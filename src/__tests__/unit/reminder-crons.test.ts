import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { users, timesheetEntries, notificationPreferences, workspaceSettings, timesheetPeriods } from '@/db/schema';

/**
 * feature-plan-launch-blockers.md P6 §4 / §9 "Crons": the reminder crons skip SEED_EMAIL_DOMAINS recipients (demo
 * domains we don't own) but still remind a lifecycle-exempt REAL tenant (lifecycle_exempt can cover comped customers),
 * and stop sending — returning 'stopped' to the sweep — once out of time.
 */

type Tenant = { slug: string; status: string; lifecycleExempt: boolean; dbUrlEncrypted: string };
const h = vi.hoisted(() => ({
  tenants: [] as Tenant[],
  employees: {} as Record<string, Array<{ id: string; fullName: string; email: string }>>,
  outOfTime: false,
  outcomes: [] as Array<'done' | 'stopped'>,
  daily: vi.fn(async (args: { employeeEmail: string }) => { void args; return { ok: true as const, id: 'm' }; }),
  deadline: vi.fn(async (args: { employeeEmail: string }) => { void args; return { ok: true as const, id: 'm' }; }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cron/run-cron', () => ({
  runCron: async (_req: unknown, _name: string, work: () => Promise<Record<string, unknown>>) => Response.json(await work()),
}));
vi.mock('@/lib/cron/tenant-sweep', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cron/tenant-sweep')>();
  return {
    ...real,
    sweepTenants: async (opts: { tenants: Tenant[]; processTenant: (t: Tenant, ctx: { outOfTime: () => boolean }) => Promise<'done' | 'stopped'> }) => {
      for (const t of opts.tenants) h.outcomes.push(await opts.processTenant(t, { outOfTime: () => h.outOfTime }));
      return { processed: opts.tenants.length, candidates: opts.tenants.length, failedTenants: [], incomplete: false, cursor: null };
    },
  };
});
vi.mock('@/db/control-plane', () => ({
  controlDb: { select: () => ({ from: () => ({ where: async () => h.tenants }) }) },
}));
vi.mock('@/lib/tenant/registry', () => ({ toLifecycleFacts: (t: unknown) => t }));
vi.mock('@/lib/tenant/lifecycle', () => ({ getTenantAccess: () => 'full' }));
vi.mock('@/lib/encryption', () => ({ decrypt: (s: string) => s }));
vi.mock('@/lib/email/rate', () => ({ createSendThrottle: () => async () => {} }));
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
        const result = Object.assign(Promise.resolve(rows), { limit: async () => rows, where: async () => rows });
        return result;
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
  h.outOfTime = false;
  h.outcomes = [];
  h.tenants = [
    { slug: 'demo', status: 'active', lifecycleExempt: true, dbUrlEncrypted: 'db-demo' },
    { slug: 'comped', status: 'active', lifecycleExempt: true, dbUrlEncrypted: 'db-comped' },
  ];
  h.employees = {
    'db-demo': [{ id: 'd1', fullName: 'Demo Jane', email: 'jane@cadenzpoint.dev' }, { id: 'd2', fullName: 'Demo Joe', email: 'joe@bytime.dev' }],
    'db-comped': [{ id: 'c1', fullName: 'Real Person', email: 'real@comped-customer.com' }],
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
    expect(sender().mock.calls.map(([a]) => a.employeeEmail)).toEqual(['real@comped-customer.com']);
    expect(body.skippedSeedRecipients).toBe(2);
    expect(body.sent).toBe(1);
  });

  it('out of time → sends nothing more and reports the tenant as stopped', async () => {
    h.outOfTime = true;
    await run();
    expect(sender()).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['done', 'stopped']); // demo: only seed recipients (nothing to send); comped: stopped
  });
});
