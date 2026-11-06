import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, cleanupTestData } from './helpers';
import { countingDb } from './query-counter';
import { seedPayrollP5Fixture, normalizePayload } from './payroll-p5-fixture';

/**
 * feature-plan-ux-approvals-payroll.md §4.1 against real Postgres.
 * P-1 — loadPayrollData: 5 queries for 3 users (counting Proxy) and still 5 with no entries; an inactive exempt user
 *       with only approved hours keeps their name with 0 overtime; a user created today with a stored submitted row in
 *       range is listed; notIncluded covers submitted, returned, a stored draft, no row with 8 h → draft, no row and
 *       0 h → none; a mid-range hire isn't listed for a period that ended before their creation day; partly included;
 *       approved not listed.
 * P-5 — the Gusto sync payload deep-equals the one recorded on the code BEFORE Part 2 (ux4b2 recorder, 2026-11-04) for
 *       the P-5 fixture (an expected user with no entries, an inactive exempt user with approved hours, a misaligned
 *       approved row with a null period_num_days). A regression guard (exempt from the revert check).
 */

const RECORDED_P5_PAYLOAD = {
  periodStart: '2026-03-01', periodEnd: '2026-03-15',
  employees: [
    { userId: 'Ivy Exempt', employeeName: 'Ivy Exempt', regularHours: 40, overtimeHours: 0, ptoHours: 0, sickHours: 0, holidayHours: 0, uncompensatedOvertimeHours: 10, flagged: false },
    { userId: 'Mo Misaligned', employeeName: 'Mo Misaligned', regularHours: 24, overtimeHours: 0, ptoHours: 0, sickHours: 0, holidayHours: 0, uncompensatedOvertimeHours: 0, flagged: false },
    { userId: 'Pat Doe', employeeName: 'Pat Doe', regularHours: 40, overtimeHours: 5, ptoHours: 0, sickHours: 0, holidayHours: 0, uncompensatedOvertimeHours: 0, flagged: false },
  ],
};

const h = vi.hoisted(() => ({ counted: null as null | { db: object; counter: { n: number } }, captured: null as unknown, user: null as null | { id: string; role: string; email: string; fullName: string } }));
vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => h.counted?.db ?? getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000p1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = async () => {
    if (!h.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return h.user;
  };
  return { ...actual, getSessionUser: current, requireSession: current, requireAdmin: current, requireAdminFresh: current };
});
vi.mock('@/lib/integrations/registry', () => ({
  getConnector: () => ({
    pushPayroll: async (_ctx: unknown, input: { employees: unknown[] }) => { h.captured = input; return { pushed: input.employees.length, failed: 0, skipped: 0, errors: [] }; },
  }),
}));

import { loadPayrollData } from '@/server/internal/payroll-data';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';
import { updateWorkweekStartDay } from '@/server/actions/workspace-settings';
import type { CalendarDate } from '@/lib/calendar-date';

const d = (s: string) => s as CalendarDate;

describe('loadPayrollData — not in this file (P-1)', () => {
  let clinId: string;
  const db = () => getTestDb();
  const work = (userId: string, date: string, hours: string) =>
    db().insert(schema.timesheetEntries).values({ userId, clinId, entryDate: date, hours, revisionNumber: 1, createdBy: userId });
  const period = (userId: string, status: 'draft' | 'submitted' | 'approved' | 'rejected', o: Partial<typeof schema.timesheetPeriods.$inferInsert> = {}) =>
    db().insert(schema.timesheetPeriods).values({ userId, periodStart: '2026-03-01', periodNumDays: 15, periodType: 'semimonthly', status, submittedAt: new Date('2026-03-16T14:00:00Z'), ...o });

  beforeEach(async () => {
    await cleanupTestData();
    const admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    h.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
    await updateWorkweekStartDay(1);
    clinId = (await createTestClin((await createTestContract()).id)).id;
  });
  afterEach(async () => { h.counted = null; h.user = null; await cleanupTestData(); });

  it('5 queries for 3 users; the inactive exempt user keeps their name with 0 overtime; statuses; Review; approved not listed', async () => {
    const pat = await createTestUser({ role: 'employee', fullName: 'Pat Approved' });
    const ivy = await createTestUser({ role: 'employee', fullName: 'Ivy Exempt', flsaExempt: true, isActive: false });
    const sue = await createTestUser({ role: 'employee', fullName: 'Sue Submitted' });
    await period(pat.id, 'approved');
    await period(ivy.id, 'approved');
    await period(sue.id, 'submitted');
    await work(pat.id, '2026-03-02', '8.00');
    for (const day of ['02', '03', '04', '05', '06']) await work(ivy.id, `2026-03-${day}`, '10.00');
    await work(sue.id, '2026-03-03', '8.00');
    h.counted = countingDb(getTestDb());
    const data = await loadPayrollData(h.counted.db as never, d('2026-03-01'), d('2026-03-15'));
    const n = h.counted.counter.n;
    h.counted = null;
    expect(n).toBe(5);
    expect(data.employees.map((e) => [e.employeeName, e.overtime, e.uncompensatedOvertime])).toEqual([['Ivy Exempt', 0, 1000], ['Pat Approved', 0, 0]]);
    expect(data.notIncluded.map((x) => [x.employeeName, x.status, x.hoursInRange, x.canReview])).toEqual([['Sue Submitted', 'submitted', 8, true]]);
  });

  it('returned, stored draft, no row with 8 h → draft, no row and 0 h → none; a later hire is not listed, a mid-period hire is; created today with a stored row is', async () => {
    const ret = await createTestUser({ role: 'employee', fullName: 'Rae Returned' });
    const dra = await createTestUser({ role: 'employee', fullName: 'Dan Draft' });
    const hrs = await createTestUser({ role: 'employee', fullName: 'Hal Hours' });
    const non = await createTestUser({ role: 'employee', fullName: 'Nia None', createdAt: new Date('2026-01-05T12:00:00Z') });
    await createTestUser({ role: 'employee', fullName: 'Ned Later', createdAt: new Date('2026-03-20T15:00:00Z') });
    await createTestUser({ role: 'employee', fullName: 'Mia Mid', createdAt: new Date('2026-03-10T15:00:00Z') });
    const imp = await createTestUser({ role: 'employee', fullName: 'Ike Imported' });                  // created today
    await period(ret.id, 'rejected', { reviewedAt: new Date('2026-03-18T14:00:00Z') });
    await period(dra.id, 'draft', { submittedAt: null });
    await period(imp.id, 'submitted');
    await work(hrs.id, '2026-03-04', '8.00');
    void non;
    const data = await loadPayrollData(getTestDb(), d('2026-03-01'), d('2026-03-15'));
    const shown = data.notIncluded.filter((x) => x.employeeName !== 'Ann Admin').map((x) => [x.employeeName, x.status, x.hoursInRange]);
    expect(shown).toEqual([
      ['Ike Imported', 'submitted', 0],
      ['Rae Returned', 'rejected', 0],
      ['Dan Draft', 'draft', 0],
      ['Hal Hours', 'draft', 8],
      ['Mia Mid', 'none', 0],
      ['Nia None', 'none', 0],
    ]);
    expect(data.notIncluded.find((x) => x.employeeName === 'Rae Returned')!.returnedAt).toBe('2026-03-18T14:00:00.000Z');
  });

  it('no entries in range → every expected person listed, still 5 queries; partly included across two periods', async () => {
    await createTestUser({ role: 'employee', fullName: 'Zed Zero', createdAt: new Date('2026-01-05T12:00:00Z') });
    h.counted = countingDb(getTestDb());
    const empty = await loadPayrollData(h.counted.db as never, d('2026-03-01'), d('2026-03-15'));
    expect(h.counted.counter.n).toBe(5);
    h.counted = null;
    expect(empty.notIncluded.map((x) => [x.employeeName, x.status])).toEqual([['Zed Zero', 'none']]);

    const pat = await createTestUser({ role: 'employee', fullName: 'Pat Part', createdAt: new Date('2026-01-05T12:00:00Z') });
    await period(pat.id, 'approved');
    await work(pat.id, '2026-03-02', '8.00');
    const two = await loadPayrollData(getTestDb(), d('2026-03-01'), d('2026-03-31'));
    expect(two.notIncluded.find((x) => x.employeeName === 'Pat Part')).toMatchObject({ status: 'none', periodStart: '2026-03-16', periodEnd: '2026-03-31', partlyIncluded: true });
  });
});

describe('the Gusto sync payload is unchanged (P-5, a regression guard)', () => {
  beforeEach(async () => { await cleanupTestData(); h.captured = null; });
  afterEach(async () => { h.user = null; await cleanupTestData(); });

  it('deep-equals the payload recorded before Part 2', async () => {
    const { names } = await seedPayrollP5Fixture();
    const db = getTestDb();
    const [admin] = await db.insert(schema.users).values({ email: `p5-${Date.now()}@bytime.dev`, fullName: 'P5 Admin', role: 'admin', passwordHash: 'x', isActive: true }).returning();
    h.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
    await updateWorkweekStartDay(1);
    const [conn] = await db.insert(schema.integrationConnections).values({ provider: 'gusto', displayName: 'Gusto — P5', isActive: true, externalCompanyId: 'co', connectedBy: admin.id }).returning();
    await executeSyncOperation(conn.id, 'timesheet_push', d('2026-03-01'), d('2026-03-15'), admin.id);
    expect(normalizePayload(h.captured, names)).toEqual(RECORDED_P5_PAYLOAD);
  });
});
