import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, cleanupTestData } from './helpers';
import { countingDb } from './query-counter';
import { seedReviewReadFixture, REVIEW_START } from './review-read-fixture';

/**
 * feature-plan-ux-approvals-payroll.md §3.1.5 / A-4: getTimesheetForReview against real Postgres on the review-read
 * fixture — periodId (null with no row) and numDays; the flagged cells with their history, originallyLate and
 * sinceReturned; lastReturn only when submitted more than once; and the QUERY COUNT: the baseline recorded on the code
 * before Part 2 was 13 (ux4b2 recorder, 2026-11-04); passing numDays down removes the two period-length reads → 11.
 * getTimesheetPeriod and getTimesheetEntries still return plain TimesheetEntry[] (no revision chains).
 */

const BASELINE_QUERIES = 13;

const h = vi.hoisted(() => ({ counted: null as null | { db: object; counter: { n: number } }, user: null as null | { id: string; role: string; email: string; fullName: string } }));
vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => h.counted?.db ?? getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000a4', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = async () => {
    if (!h.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return h.user;
  };
  return { ...actual, getSessionUser: current, requireSession: current, assertCanAccessEmployee: async () => {}, getEmployeeScope: async () => 'all' };
});

import { getTimesheetForReview, getTimesheetPeriod, getTimesheetEntries } from '@/server/actions/timesheet';
import type { CalendarDate } from '@/lib/calendar-date';

describe('getTimesheetForReview (A-4)', () => {
  beforeEach(async () => { await cleanupTestData(); h.counted = null; });
  afterEach(async () => { h.counted = null; h.user = null; await cleanupTestData(); });

  async function asAdmin() {
    const f = await seedReviewReadFixture();
    h.user = { id: f.admin.id, role: 'admin', email: f.admin.email, fullName: f.admin.fullName };
    return f;
  }

  it('the query count is the recorded baseline − 2', async () => {
    const { rob } = await asAdmin();
    h.counted = countingDb(getTestDb());
    await getTimesheetForReview(rob.id, REVIEW_START);
    const n = h.counted.counter.n;
    h.counted = null;
    expect(n).toBe(BASELINE_QUERIES - 2);
    expect(n).toBe(11);
  });

  it('periodId, numDays, submit note; flagged cells with history; originallyLate; sinceReturned; lastReturn', async () => {
    const { rob, code, periodId } = await asAdmin();
    const r = await getTimesheetForReview(rob.id, REVIEW_START);
    expect(r).toMatchObject({ periodId, numDays: 15, submissionCount: 2, submittedAt: '2026-03-16T15:00:00.000Z', submittedComment: 'All done.' });
    expect(r.lastReturn).toEqual({ comment: 'Please add the site visit.', byName: 'Ann Admin', at: '2026-03-16T12:00:00.000Z' });
    const brief = r.flagged.map((f) => ({ rowId: f.rowId, day: f.dayIndex, kind: f.kind, originallyLate: f.originallyLate, sinceReturned: f.sinceReturned, prev: f.previousHours, now: f.current.hours, revs: f.history.map((x) => x.revision) }));
    expect(brief).toEqual([
      { rowId: code.id, day: 2, kind: 'correction', originallyLate: false, sinceReturned: false, prev: 8, now: 6, revs: [1, 2] },
      { rowId: code.id, day: 3, kind: 'late', originallyLate: false, sinceReturned: false, prev: null, now: 4, revs: [1] },
      { rowId: code.id, day: 4, kind: 'correction', originallyLate: true, sinceReturned: true, prev: 2, now: 3, revs: [1, 2] },
    ]);
    expect(r.flagged[0].current).toMatchObject({ reasonCode: 'CORRECTION', comment: 'Left early.', createdAt: '2026-03-10T21:00:00.000Z', source: 'app' });
  });

  it('no period row → periodId null, no flags from returns, no lastReturn; submitted once → no lastReturn', async () => {
    const { rob, periodId } = await asAdmin();
    const none = await getTimesheetForReview(rob.id, '2026-02-16' as CalendarDate);
    expect(none).toMatchObject({ periodId: null, lastReturn: null, flagged: [], submittedAt: null });
    await getTestDb().update(schema.timesheetPeriods).set({ submissionCount: 1 }).where(eq(schema.timesheetPeriods.id, periodId));
    const once = await getTimesheetForReview(rob.id, REVIEW_START);
    expect(once.lastReturn).toBeNull();
    expect(once.flagged.every((f) => !f.sinceReturned)).toBe(true);
  });

  it('getTimesheetPeriod and getTimesheetEntries: the same entries, with no revision chains', async () => {
    const { admin, rob } = await asAdmin();
    const review = await getTimesheetForReview(rob.id, REVIEW_START);
    h.user = { id: rob.id, role: 'employee', email: rob.email, fullName: rob.fullName };
    const period = await getTimesheetPeriod(REVIEW_START);
    expect(period.entries).toEqual(review.entries);
    const entries = await getTimesheetEntries(REVIEW_START, review.chargeCodes);
    expect(entries).toEqual(review.entries);
    for (const e of [...entries, ...period.entries]) expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['chargeCodeId', 'hours']));
    for (const e of entries) for (const k of Object.keys(e)) expect(['chargeCodeId', 'hours', 'provenance']).toContain(k);
    expect('chains' in (period as object)).toBe(false);
    void admin;
  });
});
