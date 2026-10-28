import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-timesheet.md A-T9 (A4.7, UX3-Q1): past timesheets start at the earliest of the user's creation day,
 * first entry and first period row — imported entries before creation, with no period row, are listed — with
 * submitted / approved / rejected (comment truncated) / not-submitted rows, 26-row pages with hasMore, page
 * normalization in the action, and the session user's own data only.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000a9', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
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

import { pastPeriods } from '@/server/internal/past-periods';
import { getPastTimesheets } from '@/server/actions/timesheet';

const TODAY = '2026-10-20' as CalendarDate; // current semi-monthly period: Oct 16–31
const TZ = 'America/New_York';

describe('past periods (UX-3 A-T9)', () => {
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let code: string; let clinId: string;
  const db = () => getTestDb();
  const list = (userId = emp.id, page = 0, size = 26) => pastPeriods(db(), userId, page, size, TODAY, TZ);
  const hours = (userId: string, entryDate: string, h: string, extra: Partial<typeof schema.timesheetEntries.$inferInsert> = {}) =>
    db().insert(schema.timesheetEntries).values({ userId, chargeCodeId: code, clinId, entryDate, hours: h, revisionNumber: 1, createdBy: userId, ...extra });
  const period = (userId: string, periodStart: string, status: 'draft' | 'submitted' | 'approved' | 'rejected', o: Partial<typeof schema.timesheetPeriods.$inferInsert> = {}) =>
    db().insert(schema.timesheetPeriods).values({ userId, periodStart, status, periodNumDays: 15, submissionCount: status === 'draft' ? 0 : 1, submittedAt: status === 'draft' ? null : new Date('2026-09-15T14:00:00Z'), ...o });

  beforeEach(async () => {
    await cleanupTestData();
    emp = await createTestUser({ role: 'employee', createdAt: new Date('2026-09-02T15:00:00Z') });
    session.user = { id: emp.id, role: 'employee', email: emp.email, fullName: emp.fullName };
    clinId = (await createTestClin((await createTestContract()).id)).id;
    code = (await createTestChargeCode(clinId)).id;
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('starts at the creation day when nothing is older: current first, newest to oldest', async () => {
    const r = await list();
    expect(r.rows.map((x) => [x.start, x.isCurrent])).toEqual([['2026-10-16', true], ['2026-10-01', false], ['2026-09-16', false], ['2026-09-01', false]]);
    expect(r).toMatchObject({ page: 0, hasMore: false });
    expect(r.rows[0]).toMatchObject({ label: 'Oct 16 – Oct 31, 2026', numDays: 16, status: 'notSubmitted', hours: 0 });
  });

  it('imported entries before creation, with no period row, extend the list back to their period', async () => {
    await hours(emp.id, '2026-07-05', '6', { source: 'migration', changeReasonCode: 'MIGRATION' });
    const r = await list();
    expect(r.rows.map((x) => x.start).slice(-2)).toEqual(['2026-07-16', '2026-07-01']);
    expect(r.rows.at(-1)).toMatchObject({ start: '2026-07-01', status: 'notSubmitted', hours: 6 });
  });

  it('an older period row extends it too', async () => {
    await period(emp.id, '2026-06-16', 'approved');
    expect((await list()).rows.at(-1)).toMatchObject({ start: '2026-06-16', status: 'approved' });
  });

  it('statuses: submitted, approved, rejected (comment truncated to 140 + …), draft and missing rows → notSubmitted; latest-revision hours', async () => {
    const long = 'x'.repeat(200);
    await period(emp.id, '2026-09-01', 'approved', { reviewedAt: new Date('2026-09-17T14:00:00Z') });
    await period(emp.id, '2026-09-16', 'rejected', { reviewComment: long });
    await period(emp.id, '2026-10-01', 'submitted');
    await period(emp.id, '2026-10-16', 'draft');
    await hours(emp.id, '2026-09-17', '8');
    await db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId: code, clinId, entryDate: '2026-09-17', hours: '5', revisionNumber: 2, createdBy: emp.id, changeReasonCode: 'CORRECTION', comment: 'x' });
    await hours(emp.id, '2026-09-18', '3');
    const byStart = Object.fromEntries((await list()).rows.map((x) => [x.start, x]));
    expect(byStart['2026-10-16'].status).toBe('notSubmitted');
    expect(byStart['2026-10-01'].status).toBe('submitted');
    expect(byStart['2026-09-16']).toMatchObject({ status: 'rejected', hours: 8, reviewComment: `${'x'.repeat(140)}…` });
    expect(byStart['2026-09-01']).toMatchObject({ status: 'approved', reviewedAt: new Date('2026-09-17T14:00:00Z'), approvalBadge: null });
  });

  it('26-row pages with hasMore', async () => {
    await hours(emp.id, '2025-01-10', '1', { source: 'migration', changeReasonCode: 'MIGRATION' }); // Jan 1, 2025 → Oct 16, 2026: 44 periods
    const first = await list();
    expect(first.rows).toHaveLength(26);
    expect(first).toMatchObject({ page: 0, hasMore: true });
    expect(first.rows[0].isCurrent).toBe(true);
    const second = await list(emp.id, 1);
    expect(second.rows).toHaveLength(18);
    expect(second).toMatchObject({ page: 1, hasMore: false });
    expect(second.rows.at(-1)!.start).toBe('2025-01-01');
    expect(new Set([...first.rows, ...second.rows].map((x) => x.start)).size).toBe(44);
  });

  it('own data only; the action treats page -1 or \'x\' as page 0', async () => {
    const other = await createTestUser({ role: 'employee', createdAt: new Date('2026-09-02T15:00:00Z') });
    await period(other.id, '2026-09-16', 'approved');
    await hours(other.id, '2026-09-17', '9');
    // L8: the other user's history OLDER than this employee's creation must not move this employee's bound.
    await period(other.id, '2026-03-01', 'approved');
    await hours(other.id, '2026-02-10', '4', { source: 'migration', changeReasonCode: 'MIGRATION' });
    expect((await list()).rows.at(-1)!.start).toBe('2026-09-01');
    expect((await list()).rows).toHaveLength(4);
    expect((await list()).rows.find((x) => x.start === '2026-09-16')).toMatchObject({ status: 'notSubmitted', hours: 0 });
    const zero = await getPastTimesheets({ page: 0 });
    expect(await getPastTimesheets({ page: -1 })).toEqual(zero);
    expect(await getPastTimesheets({ page: 'x' })).toEqual(zero);
    expect(await getPastTimesheets()).toEqual(zero);
    expect(zero.rows.find((x) => x.start === '2026-09-16')).toMatchObject({ status: 'notSubmitted', hours: 0 });
  });
});
