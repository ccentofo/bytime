import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema';
import type { ReminderMessage } from '@/lib/email/reminder-messages';
import {
  getTestDb, cleanupTestData, createTestUser, createTestContract, createTestClin, createTestChargeCode,
} from './helpers';
import { countingDb } from './query-counter';

/**
 * feature-plan-reminder-capacity.md §11 I1–I3: the batched reminder crons against real Postgres. The batch helper is
 * replaced (it records the messages); the tenant DB is the test DB behind a query counter.
 * - I1: the deadline cron's per-workspace reads (§6.7) give exactly today's recipients, including the periodStart filter.
 * - I2: the deadline cron's query count doesn't grow with headcount.
 * - I3: the daily cron excludes employees with an entry today only.
 */

const TODAY = '2026-10-21'; // a Wednesday in America/New_York at 20:00 UTC
const PREVIOUS_PERIOD = '2026-10-07'; // TODAY − 14

const h = vi.hoisted(() => ({
  counted: null as null | { db: object; counter: { n: number } },
  batch: vi.fn(),
}));

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDbForUrl: () => {
    // Built lazily: __TEST_DB__ exists only after setup-db.ts's beforeAll.
    if (!h.counted) throw new Error('countingDb not set');
    return h.counted.db;
  },
}));
vi.mock('@/lib/cron/run-cron', () => ({
  runCron: async (_req: unknown, _name: string, work: () => Promise<Record<string, unknown>>) => Response.json(await work()),
}));
vi.mock('@/lib/encryption', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/encryption')>()),
  decrypt: (s: string) => s,
}));
vi.mock('@/db/control-plane', () => ({
  controlDb: {
    select: () => ({ from: () => ({ where: async () => [{ id: '00000000-0000-4000-8000-0000000000b1', slug: 'rcint', status: 'active', dbUrlEncrypted: 'test-db' }] }) }),
  },
}));
vi.mock('@/lib/tenant/lifecycle', () => ({ getTenantAccess: () => 'full' }));
vi.mock('@/lib/tenant/registry', () => ({ toLifecycleFacts: (t: unknown) => t }));
vi.mock('@/lib/tenant/host', () => ({ tenantBaseUrl: (s: string) => `https://${s}.example.com` }));
vi.mock('@/lib/cron/tenant-sweep', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cron/tenant-sweep')>();
  return {
    ...real,
    sweepTenants: async (opts: {
      tenants: Array<{ slug: string }>;
      processTenant: (t: { slug: string }, ctx: { outOfTime: () => boolean; resumeAfter: string | null; sendCutoff: number }) => Promise<unknown>;
    }) => {
      for (const t of opts.tenants) await opts.processTenant(t, { outOfTime: () => false, resumeAfter: null, sendCutoff: Number.MAX_SAFE_INTEGER });
      return { processed: opts.tenants.length, candidates: opts.tenants.length, failedTenants: [], incomplete: false, cursor: null, resumes: {}, stopReason: null };
    },
  };
});
vi.mock('@/lib/email/send-batch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/send-batch')>()),
  deliverReminderBatch: h.batch,
}));
vi.mock('@/lib/date-utils', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/date-utils')>();
  // The deadline is today: the current period starts today and its last weekday is today.
  return { ...real, getCurrentPeriodStart: (today: string) => today, getNumDaysInPeriod: () => 14, getLastWeekdayInPeriod: (start: string) => start };
});

import { GET as dailyReminder } from '@/app/api/cron/daily-reminder/route';
import { GET as submissionDeadline } from '@/app/api/cron/submission-deadline/route';

const req = (p: string) => new NextRequest(`https://app.example.com${p}`);
const recipients = () => h.batch.mock.calls.flatMap((c) => (c[1] as ReminderMessage[]).map((m) => m.to)).sort();
const employee = (label: string) => createTestUser({ email: `${label}@rc-customer.test`, fullName: label });
const period = (userId: string, periodStart: string, status: 'draft' | 'submitted' | 'approved' | 'rejected') =>
  getTestDb().insert(schema.timesheetPeriods).values({ userId, periodStart, status });

beforeEach(async () => {
  await cleanupTestData();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T20:00:00Z`));
  h.counted = countingDb(getTestDb());
  h.batch.mockReset();
  h.batch.mockImplementation(async (_label: string, messages: ReminderMessage[]) => ({ kind: 'sent', sent: messages.length, failed: 0 }));
});
afterEach(async () => {
  vi.useRealTimers();
  h.counted = null;
  await cleanupTestData();
});

describe('submission-deadline cron, batched (I1, I2)', () => {
  it('I1: recipients are exactly draft, rejected, no period, opted in, and the previous-period-only employee', async () => {
    const db = getTestDb();
    const submitted = await employee('submitted');
    const approved = await employee('approved');
    const draft = await employee('draft');
    const rejected = await employee('rejected');
    await employee('noperiod');
    const optedOut = await employee('optedout');
    const optedIn = await employee('optedin');
    await createTestUser({ email: 'seed@cadenzpoint.dev', fullName: 'Seed' });
    const previous = await employee('previous');
    await createTestUser({ email: 'boss@rc-customer.test', role: 'admin' }); // not an employee
    await createTestUser({ email: 'gone@rc-customer.test', isActive: false }); // inactive

    await period(submitted.id, TODAY, 'submitted');
    await period(approved.id, TODAY, 'approved');
    await period(draft.id, TODAY, 'draft');
    await period(rejected.id, TODAY, 'rejected');
    await period(previous.id, PREVIOUS_PERIOD, 'submitted');
    await db.insert(schema.notificationPreferences).values([
      { userId: optedOut.id, emailDeadlineReminder: false },
      { userId: optedIn.id, emailDeadlineReminder: true },
    ]);

    const body = await (await submissionDeadline(req('/api/cron/submission-deadline'))).json();
    expect(recipients()).toEqual([
      'draft@rc-customer.test', 'noperiod@rc-customer.test', 'optedin@rc-customer.test', 'previous@rc-customer.test', 'rejected@rc-customer.test',
    ]);
    expect(body).toMatchObject({ sent: 5, skippedSeedRecipients: 1, batches: 1, stopReason: null });
  });

  it('I2: the same number of tenant-DB queries with 5 eligible employees as with 30', async () => {
    const queriesFor = async (n: number) => {
      await cleanupTestData();
      for (let i = 0; i < n; i++) await employee(`e${n}-${i}`);
      h.counted = countingDb(getTestDb());
      h.batch.mockClear();
      await submissionDeadline(req('/api/cron/submission-deadline'));
      expect(recipients()).toHaveLength(n);
      return h.counted.counter.n;
    };
    const five = await queriesFor(5);
    const thirty = await queriesFor(30);
    expect(thirty).toBe(five);
  });
});

describe('daily-reminder cron, batched (I3)', () => {
  it('I3: employees with an entry today are excluded; one with an entry yesterday only is included', async () => {
    const db = getTestDb();
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);
    const enteredToday = await employee('today');
    const enteredYesterday = await employee('yesterday');
    await employee('nothing');
    await db.insert(schema.timesheetEntries).values([
      { userId: enteredToday.id, chargeCodeId: chargeCode.id, entryDate: TODAY, hours: '8', revisionNumber: 1 },
      { userId: enteredYesterday.id, chargeCodeId: chargeCode.id, entryDate: '2026-10-20', hours: '8', revisionNumber: 1 },
    ]);

    const body = await (await dailyReminder(req('/api/cron/daily-reminder'))).json();
    expect(recipients()).toEqual(['nothing@rc-customer.test', 'yesterday@rc-customer.test']);
    expect(body).toMatchObject({ sent: 2, batches: 1, stopReason: null });
  });
});
