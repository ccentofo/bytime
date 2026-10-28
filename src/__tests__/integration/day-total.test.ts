import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, formatCalendarDate, todayIn, type CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-ux-timesheet.md A-T6 (A4.5, UX3-D4 + L1): a day can't exceed 24 hours across all codes — checked on the
 * day's latest-revision total after the batch, so two cells in ONE save are caught; a day already over 24 (imported)
 * may be lowered but not raised; a refused batch writes nothing; a notes-only batch skips the day-total reads.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000a6', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
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
const spy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/server/internal/day-totals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/internal/day-totals')>();
  return { ...actual, latestDayTotals: async (...a: Parameters<typeof actual.latestDayTotals>) => { spy.calls++; return actual.latestDayTotals(...a); } };
});

import { saveTimesheetBatch } from '@/server/actions/timesheet';

describe('24 hours per day (UX-3 A-T6)', () => {
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let a: string; let b: string; let clinId: string;
  let start: CalendarDate;
  const db = () => getTestDb();
  const rows = () => db().select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, emp.id));
  const cell = (chargeCodeId: string, hours: number, dayIndex = 1, isEdit = false) => ({ chargeCodeId, dayIndex, hours, isEdit, isLateEntry: !isEdit });
  const save = (...cells: ReturnType<typeof cell>[]) => saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells, changeReasonCode: 'CORRECTION', comment: 'fix' });
  const dayLabel = () => formatCalendarDate(addDays(start, 1), 'ddd, MMM D, YYYY');

  beforeEach(async () => {
    await cleanupTestData();
    spy.calls = 0;
    emp = await createTestUser({ role: 'employee' });
    session.user = { id: emp.id, role: 'employee', email: emp.email, fullName: emp.fullName };
    clinId = (await createTestClin((await createTestContract()).id)).id;
    a = (await createTestChargeCode(clinId)).id;
    b = (await createTestChargeCode(clinId)).id;
    await db().insert(schema.userChargeCodes).values([{ userId: emp.id, chargeCodeId: a, isActive: true }, { userId: emp.id, chargeCodeId: b, isActive: true }]);
    const current = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    start = getPeriodStartForDate(addDays(current, -1), DEFAULT_PERIOD_CONFIG);
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('16 + 9 as two cells in ONE batch on an empty day → refused naming the day; nothing is written', async () => {
    await expectFailure(save(cell(a, 16), cell(b, 9)), 'validation', new RegExp(`Hours for ${dayLabel()} would total 25\\. A day can't exceed 24 hours`));
    expect(await rows()).toEqual([]);
  });

  it('16 then 9 in separate saves → the second is refused; 12 + 12 is fine', async () => {
    await expectOk(save(cell(a, 16)));
    await expectFailure(save(cell(b, 9)), 'validation', /would total 25/);
    expect((await rows()).map((r) => r.hours)).toEqual(['16']);
    await expectOk(save(cell(a, 12, 1, true), cell(b, 12)));
  });

  it('L1: an imported day at 30 can be lowered to 28, not raised to 31', async () => {
    for (const [code, h] of [[a, '15'], [b, '15']] as const) {
      await db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: code, clinId, entryDate: addDays(start, 1), hours: h, revisionNumber: 1, source: 'migration', changeReasonCode: 'MIGRATION', createdBy: emp.id });
    }
    await expectOk(save(cell(a, 13, 1, true)));                                    // 13 + 15 = 28 ≤ 30
    await expectFailure(save(cell(a, 16, 1, true)), 'validation', /would total 31/); // 16 + 15 = 31 > 28
    const latestA = (await rows()).filter((r) => r.chargeCodeId === a).sort((x, y) => y.revisionNumber - x.revisionNumber)[0];
    expect(latestA).toMatchObject({ hours: '13', revisionNumber: 2 });
  });

  it('a notes-only batch skips the day-total reads; a batch with cells makes two', async () => {
    await expectOk(saveTimesheetBatch({ expectedUserId: session.user!.id, periodStart: start, cells: [], notes: [{ chargeCodeId: a, dayIndex: 1, body: 'x', expectedRevision: 0 }] }));
    expect(spy.calls).toBe(0);
    await expectOk(save(cell(a, 8)));
    expect(spy.calls).toBe(2);
  });
});
