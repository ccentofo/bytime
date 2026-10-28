import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-timesheet.md A-T4: what getTimesheetPeriod / getTimesheetForReview return for a period — the latest
 * note per cell (cleared bodies carry their revision), and the review's notes read after submissionCount.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000a4', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
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

import { getTimesheetForReview, getTimesheetPeriod } from '@/server/actions/timesheet';

const fake = (u: { id: string; role: string; email: string; fullName: string }): FakeUser => ({ id: u.id, role: u.role as FakeUser['role'], email: u.email, fullName: u.fullName });

describe('timesheet read: notes (UX-3 A-T4)', () => {
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let start: CalendarDate;
  const db = () => getTestDb();
  const note = (o: Partial<typeof schema.timesheetNotes.$inferInsert> & { entryDate: string; body: string; revisionNumber: number }) =>
    db().insert(schema.timesheetNotes).values({ userId: emp.id, createdBy: emp.id, ...o });

  beforeEach(async () => {
    await cleanupTestData();
    emp = await createTestUser({ role: 'employee' });
    session.user = fake(emp);
    const current = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    start = getPeriodStartForDate(addDays(current, -1), DEFAULT_PERIOD_CONFIG);
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('the latest note per cell, keyed {rowId}-{dayIndex}; a cleared note keeps its revision; other periods and people are excluded', async () => {
    const clin = await createTestClin((await createTestContract()).id);
    const code = await createTestChargeCode(clin.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    const leave = await createTestIndirectCode();
    await note({ chargeCodeId: code.id, entryDate: start, body: 'v1', revisionNumber: 1 });
    await note({ chargeCodeId: code.id, entryDate: start, body: 'v2', revisionNumber: 2 });
    await note({ chargeCodeId: code.id, entryDate: addDays(start, 1), body: 'gone', revisionNumber: 1 });
    await note({ chargeCodeId: code.id, entryDate: addDays(start, 1), body: '', revisionNumber: 2 });
    await note({ indirectCodeId: leave.id, entryDate: addDays(start, 2), body: 'Dentist', revisionNumber: 1 });
    await note({ clinId: clin.id, entryDate: addDays(start, 3), body: 'Legacy', revisionNumber: 1 });
    await note({ chargeCodeId: code.id, entryDate: addDays(start, -1), body: 'previous period', revisionNumber: 1 });
    const other = await createTestUser({ role: 'employee' });
    await db().insert(schema.timesheetNotes).values({ userId: other.id, createdBy: other.id, chargeCodeId: code.id, entryDate: start, body: 'not mine', revisionNumber: 1 });

    const period = await getTimesheetPeriod(start);
    expect(period.notes).toEqual({
      [`${code.id}-0`]: { body: 'v2', revision: 2 },
      [`${code.id}-1`]: { body: '', revision: 2 },
      [`${leave.id}-2`]: { body: 'Dentist', revision: 1 },
      [`${clin.id}-3`]: { body: 'Legacy', revision: 1 },
    });
    // The legacy CLIN row is listed because of its note (correction-only, like a CLIN with hours).
    expect(period.chargeCodes.find((c) => c.id === clin.id)).toMatchObject({ kind: 'clin', assignable: false });
  });

  it('the review returns the same notes', async () => {
    const clin = await createTestClin((await createTestContract()).id);
    const code = await createTestChargeCode(clin.id);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    await note({ chargeCodeId: code.id, entryDate: start, body: 'For the reviewer', revisionNumber: 1 });
    const admin = await createTestUser({ role: 'admin' });
    session.user = fake(admin);
    const review = await getTimesheetForReview(emp.id, start);
    expect(review.notes).toEqual({ [`${code.id}-0`]: { body: 'For the reviewer', revision: 1 } });
  });
});

describe('timesheet read: the selected period (UX-3 A-T4)', () => {
  // Mar 1–15, 2026 (semi-monthly): Mar 1 is a Sunday, Mar 15 a Sunday; the last weekday is Fri Mar 13.
  const MAR = '2026-03-01' as CalendarDate;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let code: Awaited<ReturnType<typeof createTestChargeCode>>;
  let clinId: string;
  const db = () => getTestDb();
  const hours = (entryDate: string, h: string, revisionNumber = 1) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: code.id, clinId, entryDate, hours: h, revisionNumber, createdBy: emp.id, ...(revisionNumber > 1 ? { changeReasonCode: 'CORRECTION', comment: 'x' } : {}) });

  beforeEach(async () => {
    await cleanupTestData();
    emp = await createTestUser({ role: 'employee', createdAt: new Date('2026-01-01T03:00:00Z') }); // Dec 31, 2025 in New York
    session.user = fake(emp);
    clinId = (await createTestClin((await createTestContract()).id)).id;
    code = await createTestChargeCode(clinId);
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('reviewComment; the summary of a PAST period; submitOpensOn; userCreatedOn (workspace timezone)', async () => {
    await db().insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: MAR, status: 'rejected', periodNumDays: 15, submissionCount: 1, submittedAt: new Date(), reviewComment: 'Please split Tuesday.' });
    await hours('2026-03-03', '8');
    await hours('2026-03-03', '6', 2);
    await hours('2026-03-07', '2'); // Saturday
    const p = await getTimesheetPeriod('2026-03-05');
    expect(p).toMatchObject({ periodStart: MAR, isCurrent: false, reviewComment: 'Please split Tuesday.', submitOpensOn: '2026-03-13', userCreatedOn: '2025-12-31' });
    expect(p.summary).toMatchObject({ periodStart: MAR, periodEnd: '2026-03-15', status: 'rejected', expectedWorkdays: 10, workdaysFilled: 1, totalHoursEntered: 8, submissionDeadline: 'Mar 13, 2026' });
    expect(p.summary.dailyHours).toEqual({ '2026-03-03': 6, '2026-03-07': 2 });
  });

  it('outsideWeekHours: the edge weeks\' days outside the period — Monday workweek, then none set (Sunday)', async () => {
    await hours('2026-02-27', '5');               // Fri before the period (Monday week Feb 23–Mar 1)
    await hours('2026-02-27', '4', 2);            // latest revision wins
    await hours('2026-03-17', '7');               // Tue after the period (Sunday week Mar 15–21)
    await db().update(schema.workspaceSettings).set({ workweekStartDay: 1 });
    const monday = await getTimesheetPeriod(MAR);
    expect(monday.workweekStartDay).toBe(1);
    expect(monday.outsideWeekHours).toEqual({ '2026-02-23': 0, '2026-02-24': 0, '2026-02-25': 0, '2026-02-26': 0, '2026-02-27': 4, '2026-02-28': 0 });
    await db().update(schema.workspaceSettings).set({ workweekStartDay: null });
    const sunday = await getTimesheetPeriod(MAR);
    expect(sunday.workweekStartDay).toBeNull();
    expect(sunday.outsideWeekHours).toEqual({ '2026-03-16': 0, '2026-03-17': 7, '2026-03-18': 0, '2026-03-19': 0, '2026-03-20': 0, '2026-03-21': 0 });
  });
});

describe('getTimesheetForReview reads notes after submissionCount (UX-3 A-T4, static, C2 order)', () => {
  it('the period row (submissionCount) is read before the notes and the entries', () => {
    const src = readFileSync(path.resolve(__dirname, '../../server/actions/timesheet.ts'), 'utf8');
    const review = src.slice(src.indexOf('export async function getTimesheetForReview'), src.indexOf('async function getChargeCodesForEmployee'));
    const count = review.indexOf('submissionCount: timesheetPeriods.submissionCount');
    expect(count).toBeGreaterThan(-1);
    expect(review.indexOf('latestNotesInPeriod(')).toBeGreaterThan(count);
    expect(review.indexOf('getTimesheetEntriesForEmployee(')).toBeGreaterThan(count);
  });
});
