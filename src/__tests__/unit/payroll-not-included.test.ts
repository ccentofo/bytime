import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-approvals-payroll.md §4.1 / P-1, P-2, unit companion to integration/payroll-not-included.test.ts,
 * runnable without Postgres (scripted rows; the REAL schedule resolver over an empty config = semi-monthly):
 * 5 reads (settings, entries, people, periods, schedule) — also with no entries; "not in this file" covers submitted
 * (Review), returned, a stored draft, no row with hours → draft, no row and no hours → none; an expected person
 * created after a period ended isn't listed for it, a mid-period hire is, and an imported user created today with a
 * stored row is; approved periods aren't listed; partlyIncluded; the order. P-2: totals are integer-cent sums;
 * paid leave excludes unpaid; exempt overtime 0.
 */

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'admin-1', email: 'a@x', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import * as dbModule from '@/db';
import { payPeriodConfig, timesheetEntries, timesheetPeriods, users, workspaceSettings } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { loadPayrollData } from '@/server/internal/payroll-data';
import { getPayrollExportPreview } from '@/server/actions/payroll-export';
import type { CalendarDate } from '@/lib/calendar-date';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const d = (s: string) => s as CalendarDate;
beforeEach(() => db.reset());

const person = (id: string, fullName: string, o: Record<string, unknown> = {}) =>
  ({ id, fullName, email: `${id}@x`, flsaExempt: false, isActive: true, role: 'employee', createdAt: new Date('2026-01-05T12:00:00Z'), ...o });
const work = (userId: string, entryDate: string, hours: string, o: Record<string, unknown> = {}) =>
  ({ userId, entryDate, hours, clinId: 'clin-1', indirectCode: null, indirectCategory: null, leavePayType: null, ...o });
const row = (id: string, userId: string, status: string, o: Record<string, unknown> = {}) =>
  ({ id, userId, periodStart: '2026-10-01', periodNumDays: 15, status, submittedAt: new Date('2026-10-16T14:00:00Z'), reviewedAt: null, ...o });
const script = (o: { entries: unknown[]; people: unknown[]; periods: unknown[] }) => {
  db.onSelect(workspaceSettings, [{ day: 1, timezone: 'America/New_York' }]);
  db.onSelect(timesheetEntries, o.entries as never);
  db.onSelect(users, o.people as never);
  db.onSelect(timesheetPeriods, o.periods as never);
  db.onSelect(payPeriodConfig, []);
};
const selects = () => db.ops.filter((x) => x === 'select').length;

describe('loadPayrollData — not in this file (P-1 companion)', () => {
  it('statuses, Review, the createdAt rule, approved not listed, ivy keeps her name with 0 overtime; 5 reads; the order', async () => {
    script({
      entries: [
        work('sub', '2026-10-05', '8.00'),
        work('hrs', '2026-10-06', '8.00'),
        work('app', '2026-10-07', '8.00'),
        ...['05', '06', '07', '08', '09'].map((dd) => work('ivy', `2026-10-${dd}`, '10.00')),
      ],
      people: [
        person('sub', 'Sue Submitted'), person('ret', 'Rae Returned'), person('dra', 'Dan Draft'), person('hrs', 'Hal Hours'),
        person('non', 'Nia None'), person('new', 'Ned New', { createdAt: new Date('2026-10-20T15:00:00Z') }),
        person('mid', 'Mia Mid', { createdAt: new Date('2026-10-10T15:00:00Z') }),
        person('imp', 'Ike Imported', { createdAt: new Date('2026-11-04T15:00:00Z') }),
        person('app', 'Abe Approved'), person('ivy', 'Ivy Exempt', { flsaExempt: true, isActive: false }),
      ],
      periods: [
        row('p-sub', 'sub', 'submitted'),
        row('p-ret', 'ret', 'rejected', { reviewedAt: new Date('2026-10-18T14:00:00Z'), periodNumDays: null }), // no snapshot: no per-row read
        row('p-dra', 'dra', 'draft', { submittedAt: null }),
        row('p-imp', 'imp', 'submitted'),
        row('p-app', 'app', 'approved'),
        row('p-ivy', 'ivy', 'approved'),
      ],
    });
    const data = await loadPayrollData(db as never, d('2026-10-01'), d('2026-10-15'));
    expect(selects()).toBe(5);
    expect(data.notIncluded.map((n) => [n.employeeName, n.status, n.periodId, n.hoursInRange, n.canReview])).toEqual([
      ['Ike Imported', 'submitted', 'p-imp', 0, true],
      ['Sue Submitted', 'submitted', 'p-sub', 8, true],
      ['Rae Returned', 'rejected', 'p-ret', 0, false],
      ['Dan Draft', 'draft', 'p-dra', 0, false],
      ['Hal Hours', 'draft', null, 8, false],
      ['Mia Mid', 'none', null, 0, false],
      ['Nia None', 'none', null, 0, false],
    ]);
    const ret = data.notIncluded.find((n) => n.userId === 'ret')!;
    expect(ret).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-15', returnedAt: '2026-10-18T14:00:00.000Z', submittedAt: '2026-10-16T14:00:00.000Z' });
    // The file itself: Abe and Ivy (inactive, exempt, all approved) keep their names; Ivy's overtime is 0.
    expect(data.employees.map((e) => [e.employeeName, e.overtime, e.uncompensatedOvertime])).toEqual([['Abe Approved', 0, 0], ['Ivy Exempt', 0, 1000]]);
  });

  it('no entries in range → every expected person listed as not started; still 5 reads', async () => {
    script({ entries: [], people: [person('a', 'Ann A'), person('b', 'Ben B')], periods: [] });
    const data = await loadPayrollData(db as never, d('2026-10-01'), d('2026-10-15'));
    expect(selects()).toBe(5);
    expect(data.employees).toEqual([]);
    expect(data.notIncluded.map((n) => [n.employeeName, n.status, n.periodStart, n.periodEnd])).toEqual([
      ['Ann A', 'none', '2026-10-01', '2026-10-15'], ['Ben B', 'none', '2026-10-01', '2026-10-15'],
    ]);
  });

  it('partlyIncluded: an approved period in the file, the next one not started; a resolver period never overlaps a stored row', async () => {
    script({
      entries: [work('p', '2026-10-05', '8.00')],
      people: [person('p', 'Pat Part')],
      periods: [row('p-1', 'p', 'approved'), row('p-odd', 'p', 'submitted', { periodStart: '2026-10-20', periodNumDays: 5 })],
    });
    const data = await loadPayrollData(db as never, d('2026-10-01'), d('2026-10-31'));
    // Oct 16–31 overlaps the stored Oct 20 row → not listed as a resolver period; the stored row is.
    expect(data.notIncluded.map((n) => [n.status, n.periodStart, n.periodEnd, n.partlyIncluded])).toEqual([['submitted', '2026-10-20', '2026-10-24', true]]);
  });
});

describe('a stored length of 0 (UX-4B2-AUDIT.md L1)', () => {
  it('falls back to the schedule\'s length, as existingPeriodLength does: the approved days are in the file', async () => {
    script({ entries: [work('z', '2026-10-05', '8.00')], people: [person('z', 'Zed Zero')], periods: [row('p-z', 'z', 'approved', { periodNumDays: 0 })] });
    const data = await loadPayrollData(db as never, d('2026-10-01'), d('2026-10-15'));
    expect(data.employees.map((e) => [e.employeeName, e.regular])).toEqual([['Zed Zero', 800]]);
    expect(data.notIncluded).toEqual([]);
  });
});

describe('uncovered days next to a stored row (UX-4B2-AUDIT.md M4)', () => {
  it('hours on days a stored row doesn\'t cover, in an overlapping schedule period → one draft clipped to those days', async () => {
    script({
      entries: [work('m', '2026-10-05', '8.00'), work('m', '2026-10-12', '4.00'), work('n', '2026-10-05', '8.00')],
      people: [person('m', 'Max Moved'), person('n', 'Nell None')],
      // A 10-day row (Oct 1 – 10, e.g. after a schedule change) inside the schedule's Oct 1 – 15.
      periods: [row('p-m', 'm', 'submitted', { periodNumDays: 10 }), row('p-n', 'n', 'submitted', { periodNumDays: 10 })],
    });
    const data = await loadPayrollData(db as never, d('2026-10-01'), d('2026-10-15'));
    expect(data.notIncluded.map((x) => [x.employeeName, x.status, x.periodId, x.periodStart, x.periodEnd, x.hoursInRange])).toEqual([
      ['Max Moved', 'submitted', 'p-m', '2026-10-01', '2026-10-10', 8],
      ['Nell None', 'submitted', 'p-n', '2026-10-01', '2026-10-10', 8],
      ['Max Moved', 'draft', null, '2026-10-11', '2026-10-15', 4],          // Nell has no uncovered hours: nothing more
    ]);
  });
});

describe('the P-5 fixture (companion to integration/payroll-p5-fixture.ts, UX-4B2-AUDIT.md M3)', () => {
  it('Mo\'s misaligned row (Mar 3, no stored length) never approves Mar 2: the recorded 24 h, unflagged', async () => {
    script({
      entries: [
        ...['02', '03', '04', '05', '06'].map((dd) => work('pat', `2026-03-${dd}`, '9.00')),
        ...['09', '10', '11', '12', '13'].map((dd) => work('ivy', `2026-03-${dd}`, '10.00')),
        ...['02', '03', '04', '13'].map((dd) => work('mo', `2026-03-${dd}`, '8.00')),
      ],
      people: [person('pat', 'Pat Doe'), person('ivy', 'Ivy Exempt', { flsaExempt: true, isActive: false }), person('mo', 'Mo Misaligned'), person('eve', 'Eve Nohours')],
      periods: [
        row('p-pat', 'pat', 'approved', { periodStart: '2026-03-01' }),
        row('p-ivy', 'ivy', 'approved', { periodStart: '2026-03-01' }),
        row('p-mo', 'mo', 'approved', { periodStart: '2026-03-03', periodNumDays: null }),
      ],
    });
    const data = await loadPayrollData(db as never, d('2026-03-01'), d('2026-03-15'));
    // The values recorded in RECORDED_P5_PAYLOAD (integration/payroll-not-included.test.ts), in cents.
    expect(data.employees.map((e) => [e.employeeName, e.regular, e.overtime, e.uncompensatedOvertime, e.otBasisIncludesUnapprovedDays])).toEqual([
      ['Ivy Exempt', 4000, 0, 1000, false],
      ['Mo Misaligned', 2400, 0, 0, false],
      ['Pat Doe', 4000, 500, 0, false],
    ]);
    expect(data.days.filter((x) => x.userId === 'mo').map((x) => x.date)).toEqual(['2026-03-03', '2026-03-04', '2026-03-13']);
  });
});

describe('a stored row\'s own length, not the snapped one (UX-4B2-AUDIT.md F2-1)', () => {
  it('an approved row from Feb 3 with no stored length covers Feb 3 – 15 (13 days), so Feb 16 is not approved', async () => {
    script({
      entries: [work('f', '2026-02-16', '8.00')],
      people: [person('f', 'Fay Feb')],
      periods: [row('p-f', 'f', 'approved', { periodStart: '2026-02-03', periodNumDays: null })],
    });
    const data = await loadPayrollData(db as never, d('2026-02-01'), d('2026-02-28'));
    // Its own length is 28 − 15 = 13 days; the snapped period's (15) would reach Feb 17 and approve Feb 16.
    expect(data.days.filter((x) => x.userId === 'f').map((x) => x.date)).not.toContain('2026-02-16');
    expect(data.notIncluded.map((n) => [n.employeeName, n.status, n.periodId, n.periodStart, n.periodEnd, n.hoursInRange])).toEqual([
      ['Fay Feb', 'draft', null, '2026-02-16', '2026-02-28', 8],
    ]);
  });
});

describe('preview totals (P-2 companion)', () => {
  it('integer-cent sums (0.10 + 0.20 = 0.30 exactly); paid leave excludes unpaid; exempt overtime 0', async () => {
    script({
      entries: [
        work('a', '2026-10-05', '0.10'), work('b', '2026-10-05', '0.20'),
        work('a', '2026-10-06', '8.00', { clinId: null, indirectCode: 'LV-AL', indirectCategory: 'leave', leavePayType: 'pto' }),
        work('b', '2026-10-06', '4.00', { clinId: null, indirectCode: 'LV-UN', indirectCategory: 'leave', leavePayType: 'unpaid' }),
        ...['05', '06', '07', '08', '09'].map((dd) => work('x', `2026-10-${dd}`, '9.00')),
      ],
      people: [person('a', 'Ann A'), person('b', 'Ben B'), person('x', 'Xia Exempt', { flsaExempt: true })],
      periods: [row('pa', 'a', 'approved'), row('pb', 'b', 'approved'), row('px', 'x', 'approved')],
    });
    const r = await getPayrollExportPreview({ periodStart: d('2026-10-01'), periodEnd: d('2026-10-15') });
    if (!r.ok || r.data.status !== 'ready') throw new Error('not ready');
    expect(r.data.totals).toEqual({ people: 3, regular: 40.3, overtime: 0, paidLeave: 8, totalPaid: 48.3 });
    expect(0.1 + 0.2).not.toBe(0.3);                                   // why cents
    expect(r.data.employees.map((e) => [e.employeeName, e.paidLeave, e.overtimeHours, e.uncompensatedOvertimeHours])).toEqual([
      ['Ann A', 8, 0, 0], ['Ben B', 0, 0, 0], ['Xia Exempt', 0, 0, 5],
    ]);
    expect(r.data.employees[0].userId).toBe('a');
  });

  it('exactly two people, 0.10 and 0.20 hours → regular and total paid are exactly 0.30', async () => {
    script({
      entries: [work('a', '2026-10-05', '0.10'), work('b', '2026-10-05', '0.20')],
      people: [person('a', 'Ann A'), person('b', 'Ben B')],
      periods: [row('pa', 'a', 'approved'), row('pb', 'b', 'approved')],
    });
    const r = await getPayrollExportPreview({ periodStart: d('2026-10-01'), periodEnd: d('2026-10-15') });
    if (!r.ok || r.data.status !== 'ready') throw new Error('not ready');
    expect(r.data.totals).toEqual({ people: 2, regular: 0.3, overtime: 0, paidLeave: 0, totalPaid: 0.3 });
  });
});

