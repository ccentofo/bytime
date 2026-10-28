import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, formatCalendarDate, todayIn, type CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-ux-timesheet.md A-T5 (A4.4, UX3-D3): hours are real numbers in quarter hours, stored exactly as given;
 * anything else is refused (never rounded, never coerced); untouched history isn't re-validated (A3.6).
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000a5', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
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

describe('quarter hours, stored exactly (UX-3 A-T5)', () => {
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let code: Awaited<ReturnType<typeof createTestChargeCode>>;
  let clinId: string;
  let start: CalendarDate; // the previous period: past days (late entries need a reason)
  const db = () => getTestDb();
  const rows = () => db().select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, emp.id));
  const save = (hours: unknown, dayIndex = 1) => saveTimesheetBatch({
    periodStart: start,
    cells: [{ chargeCodeId: code.id, dayIndex, hours: hours as number, isEdit: false, isLateEntry: true }],
    changeReasonCode: 'LATE_ENTRY', comment: 'late',
  });

  beforeEach(async () => {
    await cleanupTestData();
    emp = await createTestUser({ role: 'employee' });
    session.user = { id: emp.id, role: 'employee', email: emp.email, fullName: emp.fullName };
    clinId = (await createTestClin((await createTestContract()).id)).id;
    code = await createTestChargeCode(clinId);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    const current = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    start = getPeriodStartForDate(addDays(current, -1), DEFAULT_PERIOD_CONFIG);
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('7.25 is saved and stored as \'7.25\'', async () => {
    await expectOk(save(7.25));
    expect((await rows()).map((r) => r.hours)).toEqual(['7.25']);
  });

  it('7.3 is refused with the day; 7.2500001 is refused (no normalization); nothing is stored', async () => {
    const day = formatCalendarDate(addDays(start, 1), 'MMM D, YYYY');
    await expectFailure(save(7.3), 'validation', new RegExp(`quarter hours \\(\\.00, \\.25, \\.50 or \\.75\\)\\. 7\\.3 on ${day} isn't`));
    await expectFailure(save(7.2500001), 'validation', /quarter hours/);
    expect(await rows()).toEqual([]);
  });

  it('\'8\' and \'\' are refused ("must be a number"); nothing is stored', async () => {
    await expectFailure(save('8'), 'validation', /Hours must be a number\./);
    await expectFailure(save(''), 'validation', /Hours must be a number\./);
    await expectFailure(save('0x8'), 'validation', /Hours must be a number\./);
    expect(await rows()).toEqual([]);
  });

  it('untouched history (an imported 7.33) is not re-validated when another cell is saved', async () => {
    await db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: code.id, clinId, entryDate: start, hours: '7.33', revisionNumber: 1, createdBy: emp.id });
    await expectOk(save(8, 2));
    expect((await rows()).map((r) => r.hours).sort()).toEqual(['7.33', '8']);
  });
});
