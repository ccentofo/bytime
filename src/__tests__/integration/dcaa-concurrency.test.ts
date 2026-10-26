import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, navigatePeriod, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { todayIn, diffDays, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  cleanupTestData,
  expectOk,
  expectFailure,
} from './helpers';

/**
 * feature-plan-terms-compliance-fixes.md §5.5 / §7 "DCAA": TRUNCATE is blocked on the append-only tables; a save is
 * all-or-nothing; save vs (first) submit serialize on the per-employee lock; two reviewers can't both decide one
 * period. Writes get their OWN connection per call so concurrent transactions genuinely race.
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const writers: postgres.Sql[] = [];

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForWrite: async () => {
    const client = postgres(process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test', { max: 1 });
    writers.push(client);
    return drizzle(client, { schema });
  },
}));

const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant' }));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => tenantState.requestSlug }));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };
const sessionState = vi.hoisted(() => ({ user: null as null | FakeSessionUser }));
vi.mock('@/auth', () => ({
  auth: async () => (sessionState.user ? { user: { ...sessionState.user, tenantSlug: tenantState.requestSlug } } : null),
}));
// vitest 2.1.9 quirk: when two calls dynamically import() the same MOCKED module at the same moment, the overlapping
// import receives the REAL module (reproduced in isolation). getSessionUser lazily imports the tenant context, so
// concurrent server actions here would see a "missing" session. These tests are about database locking, so the
// session guards are stubbed from the same session state (production has no mocks; Node imports are safe).
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => {
    if (!sessionState.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return sessionState.user as { id: string; email: string; fullName: string; role: 'admin' | 'supervisor' | 'employee' };
  };
  const approver = () => {
    const u = current();
    if (u.role !== 'admin' && u.role !== 'supervisor') throw new actual.AuthorizationError('forbidden', 'Forbidden: Approver role required');
    return u;
  };
  return {
    ...actual,
    getSessionUser: async () => sessionState.user,
    requireSession: async () => current(),
    requireApprover: async () => approver(),
    requireApproverFresh: async () => approver(),
  };
});

vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendDailyReminderEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendSubmissionDeadlineEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendPasswordResetEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
}));

import { saveTimesheetBatch } from '@/server/actions/timesheet';
import { submitPeriod, approvePeriod, rejectPeriod } from '@/server/actions/periods';

const actingAs = (u: { id: string; role: string; email: string; fullName: string }) => {
  sessionState.user = { id: u.id, role: u.role, email: u.email, fullName: u.fullName };
};

describe('DCAA integrity under concurrency (§5.5)', () => {
  let employee: Awaited<ReturnType<typeof createTestUser>>;
  let chargeCode: Awaited<ReturnType<typeof createTestChargeCode>>;
  let currentStart: CalendarDate;
  let previousStart: CalendarDate;

  beforeEach(async () => {
    await cleanupTestData();
    employee = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    chargeCode = await createTestChargeCode(clin.id);
    await getTestDb().insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: chargeCode.id, isActive: true });
    currentStart = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    previousStart = navigatePeriod(currentStart, 'prev', DEFAULT_PERIOD_CONFIG);
    actingAs(employee);
  });

  afterEach(async () => {
    sessionState.user = null;
    while (writers.length) await writers.pop()!.end({ timeout: 1 }).catch(() => {});
    await cleanupTestData();
  });
  afterAll(async () => {
    while (writers.length) await writers.pop()!.end({ timeout: 1 }).catch(() => {});
  });

  it('TRUNCATE is rejected on timesheet_entries and period_events', async () => {
    const raw = postgres(TEST_DB_URL, { max: 1 });
    try {
      await expect(raw`TRUNCATE timesheet_entries`).rejects.toThrow();
      await expect(raw`TRUNCATE period_events`).rejects.toThrow();
    } finally {
      await raw.end();
    }
  });

  it('a save is all-or-nothing: a failing cell leaves nothing written', async () => {
    const todayIndex = diffDays(currentStart, todayIn('America/New_York'));
    await expectFailure(saveTimesheetBatch({
      periodStart: currentStart,
      cells: [
        { chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 4, isEdit: false, isLateEntry: false },
        // Same cell again: an edit within the batch, which needs a reason code that isn't given → throws mid-transaction.
        { chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 6, isEdit: true, isLateEntry: false },
      ],
    }), 'validation', /reason code is required/);
    const rows = await getTestDb().select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, employee.id));
    expect(rows).toHaveLength(0);
  });

  it('save vs first submit serialize on the employee lock: a save never lands after the submission', async () => {
    // One existing entry so the submission is valid whichever side takes the lock first.
    await getTestDb().insert(schema.timesheetEntries).values({
      userId: employee.id, chargeCodeId: chargeCode.id, clinId: chargeCode.clinId, entryDate: previousStart, hours: '8', revisionNumber: 1, createdBy: employee.id,
    });
    // Both resolve to ActionResults (launch-blockers P4); an unexpected throw fails the test.
    const [save, submit] = await Promise.all([
      saveTimesheetBatch({
        periodStart: previousStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 1, hours: 2, isEdit: false, isLateEntry: true }],
        changeReasonCode: 'LATE_ENTRY',
      }),
      submitPeriod({ periodStart: previousStart }),
    ]);
    expect(submit.ok, `submit failed: ${submit.ok ? '' : submit.error}`).toBe(true);
    // Both transactions write only after taking the lock, so transaction-id order = lock order (now() is the
    // transaction START time and can't be used for this).
    const rows = await getTestDb().execute(sql`
      SELECT
        (SELECT max(xmin::text::bigint) FROM timesheet_entries WHERE user_id = ${employee.id} AND revision_number = 1 AND entry_date <> ${previousStart}) AS save_xid,
        (SELECT max(xmin::text::bigint) FROM period_events WHERE user_id = ${employee.id} AND event = 'submitted') AS submit_xid`);
    const { save_xid, submit_xid } = (rows as unknown as Array<{ save_xid: string | null; submit_xid: string | null }>)[0];
    if (save.ok) {
      expect(save_xid).not.toBeNull();
      expect(BigInt(save_xid!)).toBeLessThan(BigInt(submit_xid!)); // the save committed BEFORE the submission
    } else {
      expect(save.code).toBe('validation');
      expect(save.error).toMatch(/submitted|locked/i);
      expect(save_xid).toBeNull();
    }
    // After submission, any save into the period is refused.
    await expectFailure(saveTimesheetBatch({
      periodStart: previousStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: 2, hours: 2, isEdit: false, isLateEntry: true }],
      changeReasonCode: 'LATE_ENTRY',
    }), 'validation', /submitted|locked/i);
  });

  it('two reviewers deciding the same submitted period: exactly one wins, one history row', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await getTestDb().insert(schema.timesheetEntries).values({
      userId: employee.id, chargeCodeId: chargeCode.id, clinId: chargeCode.clinId, entryDate: previousStart, hours: '8', revisionNumber: 1, createdBy: employee.id,
    });
    await expectOk(submitPeriod({ periodStart: previousStart }));
    const [period] = await getTestDb().select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.userId, employee.id));
    actingAs(admin);
    const results = await Promise.all([
      approvePeriod({ periodId: period.id, seen: 1 }),
      rejectPeriod({ periodId: period.id, comment: 'fix hours', seen: 1 }),
    ]);
    expect(results.filter((r) => r.ok), results.map((r) => (r.ok ? 'ok' : `${r.code}: ${r.error}`)).join(' | ')).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    if (!loser || loser.ok) throw new Error('expected one loser');
    // Lost the race on the conditional update (conflict) or saw the period already decided (validation).
    expect(['conflict', 'validation']).toContain(loser.code);
    expect(loser.error).toMatch(/refresh|Only submitted periods/i);
    const decisions = await getTestDb().select().from(schema.periodEvents)
      .where(and(eq(schema.periodEvents.periodId, period.id), sql`${schema.periodEvents.event} IN ('approved','rejected')`));
    expect(decisions).toHaveLength(1);
  });
});
