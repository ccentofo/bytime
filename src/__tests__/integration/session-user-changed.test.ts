import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import { SESSION_USER_CHANGED } from '@/lib/timesheet/copy';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData, expectOk, expectFailure, flushAfter,
} from './helpers';

/**
 * UX-TIMESHEET-B-AUDIT H3 (DCAA): saveTimesheetBatch and submitPeriod take the id of the person whose timesheet the page
 * shows (`expectedUserId`). When a different account now holds the session (signed in from another tab), both refuse
 * with SESSION_USER_CHANGED before any read or write: no timesheet_entries, timesheet_notes or timesheet_periods row is
 * written for either person. A matching id still saves and submits.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000b3', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
}));
type FakeUser = { id: string; role: 'admin' | 'supervisor' | 'employee'; email: string; fullName: string };
const session = vi.hoisted(() => ({ user: null as null | FakeUser }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => {
    if (!session.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return session.user;
  };
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), assertCanAccessEmployee: async () => {}, getEmployeeScope: async () => 'all' };
});

import { saveTimesheetBatch } from '@/server/actions/timesheet';
import { submitPeriod } from '@/server/actions/periods';

describe('expectedUserId: a different person signed in from another tab (H3)', () => {
  let jane: Awaited<ReturnType<typeof createTestUser>>;
  let sarah: Awaited<ReturnType<typeof createTestUser>>;
  let code: Awaited<ReturnType<typeof createTestChargeCode>>;
  let start: CalendarDate; // the previous period: submittable, every day in the past
  const db = () => getTestDb();
  const as = (u: typeof jane) => { session.user = { id: u.id, role: u.role as FakeUser['role'], email: u.email, fullName: u.fullName }; };
  const written = async () => ({
    entries: (await db().select().from(schema.timesheetEntries)).length,
    notes: (await db().select().from(schema.timesheetNotes)).length,
    periods: (await db().select().from(schema.timesheetPeriods)).length,
  });
  const janesBatch = () => ({
    expectedUserId: jane.id,
    periodStart: start,
    cells: [{ chargeCodeId: code.id, dayIndex: 1, hours: 4, isEdit: false, isLateEntry: true }],
    notes: [{ chargeCodeId: code.id, dayIndex: 1, body: 'Site visit', expectedRevision: 0 }],
    changeReasonCode: 'LATE_ENTRY',
    comment: 'late',
  });

  beforeEach(async () => {
    await cleanupTestData();
    jane = await createTestUser({ role: 'employee' });
    sarah = await createTestUser({ role: 'supervisor' });
    code = await createTestChargeCode((await createTestClin((await createTestContract()).id)).id);
    // Both may book to the code, so only the identity check can stop the write.
    await db().insert(schema.userChargeCodes).values([{ userId: jane.id, chargeCodeId: code.id, isActive: true }, { userId: sarah.id, chargeCodeId: code.id, isActive: true }]);
    const current = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    start = getPeriodStartForDate(addDays(current, -1), DEFAULT_PERIOD_CONFIG);
  });
  afterEach(async () => { await flushAfter(); session.user = null; await cleanupTestData(); });

  it("saveTimesheetBatch: Jane's page, Sarah's session → refused with SESSION_USER_CHANGED; no entry or note row for anyone", async () => {
    as(sarah);
    const message = await expectFailure(saveTimesheetBatch(janesBatch()), 'validation');
    expect(message).toBe(SESSION_USER_CHANGED);
    expect(await written()).toEqual({ entries: 0, notes: 0, periods: 0 });
  });

  it("submitPeriod: Jane's page, Sarah's session → refused; no period row for anyone (nothing certified)", async () => {
    as(sarah);
    const message = await expectFailure(submitPeriod({ expectedUserId: jane.id, periodStart: start }), 'validation');
    expect(message).toBe(SESSION_USER_CHANGED);
    expect(await written()).toEqual({ entries: 0, notes: 0, periods: 0 });
  });

  it('a matching id still saves and submits (rows for the session user only)', async () => {
    as(jane);
    await expectOk(saveTimesheetBatch(janesBatch()));
    await expectOk(submitPeriod({ expectedUserId: jane.id, periodStart: start }));
    expect(await written()).toEqual({ entries: 1, notes: 1, periods: 1 });
    const [period] = await db().select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.userId, jane.id));
    expect(period.status).toBe('submitted');
  });
});
