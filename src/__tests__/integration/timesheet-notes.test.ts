import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, getNumDaysInPeriod, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode, cleanupTestData, expectOk, expectFailure,
} from './helpers';

/**
 * feature-plan-ux-timesheet.md A-T1 (UX3-D1, A4.2/A4.3, A5 "Note cell"): notes saved append-only in saveTimesheetBatch's
 * transaction, locked with the period — including NOTES-ONLY batches — with no reason code; eligibility, length,
 * future dates and the optimistic check; a note keeps its row visible after the assignment ends.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000a1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
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

import { getTimesheetPeriod, saveTimesheetBatch } from '@/server/actions/timesheet';

describe('timesheet notes (UX-3 A-T1)', () => {
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let code: Awaited<ReturnType<typeof createTestChargeCode>>;
  let clinId: string;
  let start: CalendarDate;   // the PREVIOUS period: every day is in the past
  let current: CalendarDate;
  const db = () => getTestDb();
  const noteRows = () => db().select().from(schema.timesheetNotes).where(eq(schema.timesheetNotes.userId, emp.id));
  const saveNote = (body: string, expectedRevision: number, o: Record<string, unknown> = {}) =>
    saveTimesheetBatch({ periodStart: start, cells: [], notes: [{ chargeCodeId: code.id, dayIndex: 1, body, expectedRevision, ...o }] });
  const period = (status: 'submitted' | 'approved' | 'rejected') =>
    db().insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: start, status, periodNumDays: getNumDaysInPeriod(start, DEFAULT_PERIOD_CONFIG), submissionCount: 1, submittedAt: new Date() });

  beforeEach(async () => {
    await cleanupTestData();
    emp = await createTestUser({ role: 'employee' });
    session.user = { id: emp.id, role: 'employee', email: emp.email, fullName: emp.fullName };
    clinId = (await createTestClin((await createTestContract()).id)).id;
    code = await createTestChargeCode(clinId);
    await db().insert(schema.userChargeCodes).values({ userId: emp.id, chargeCodeId: code.id, isActive: true });
    current = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    start = getPeriodStartForDate(addDays(current, -1), DEFAULT_PERIOD_CONFIG);
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('rev 1 → same body is a no-op → rev 2 → cleared (\'\') rev 3; a notes-only batch needs no reason code; bodies are stored trimmed', async () => {
    const key = `${code.id}-1`;
    expect(await expectOk(saveNote('  Site visit  ', 0))).toEqual({ revisions: {}, noteRevisions: { [key]: 1 } });
    expect(await expectOk(saveNote('Site visit', 1))).toEqual({ revisions: {}, noteRevisions: {} });            // no-op
    expect((await expectOk(saveNote('Site visit, badge outage', 1))).noteRevisions).toEqual({ [key]: 2 });
    expect((await expectOk(saveNote('', 2))).noteRevisions).toEqual({ [key]: 3 });
    expect(await expectOk(saveNote('', 3))).toEqual({ revisions: {}, noteRevisions: {} });                      // clearing again: no-op
    const rows = (await noteRows()).sort((a, b) => a.revisionNumber - b.revisionNumber);
    expect(rows.map((r) => [r.revisionNumber, r.body, r.createdBy])).toEqual([[1, 'Site visit', emp.id], [2, 'Site visit, badge outage', emp.id], [3, '', emp.id]]);
    // A brand-new cell cleared before it ever existed writes nothing.
    expect(await expectOk(saveTimesheetBatch({ periodStart: start, cells: [], notes: [{ chargeCodeId: code.id, dayIndex: 2, body: '  ', expectedRevision: 0 }] }))).toEqual({ revisions: {}, noteRevisions: {} });
  });

  it('a NOTES-ONLY batch on a submitted period is refused and writes no note row (the period lock covers note dates)', async () => {
    await period('submitted');
    await expectFailure(saveNote('After submitting', 0), 'validation', /submitted|locked/i);
    expect(await noteRows()).toEqual([]);
  });

  it('the same on an approved period', async () => {
    await period('approved');
    await expectFailure(saveNote('After approval', 0), 'validation', /approved|locked|submitted/i);
    expect(await noteRows()).toEqual([]);
  });

  it('a mixed hours + notes batch on a submitted period is refused; nothing is written', async () => {
    await period('submitted');
    await expectFailure(saveTimesheetBatch({
      periodStart: start,
      cells: [{ chargeCodeId: code.id, dayIndex: 1, hours: 4, isEdit: false, isLateEntry: true }],
      notes: [{ chargeCodeId: code.id, dayIndex: 1, body: 'x', expectedRevision: 0 }],
      changeReasonCode: 'LATE_ENTRY', comment: 'late',
    }), 'validation');
    expect(await noteRows()).toEqual([]);
    expect(await db().select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, emp.id))).toEqual([]);
  });

  it('a rejected (returned) period accepts notes', async () => {
    await period('rejected');
    expect((await expectOk(saveNote('Fixed per review', 0))).noteRevisions).toEqual({ [`${code.id}-1`]: 1 });
  });

  it('a mixed batch where the note fails rolls back the hours too', async () => {
    await expectFailure(saveTimesheetBatch({
      periodStart: start,
      cells: [{ chargeCodeId: code.id, dayIndex: 1, hours: 4, isEdit: false, isLateEntry: true }],
      notes: [{ chargeCodeId: code.id, dayIndex: 1, body: 'x', expectedRevision: 7 }], // stale
      changeReasonCode: 'LATE_ENTRY', comment: 'late',
    }), 'conflict');
    expect(await db().select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, emp.id))).toEqual([]);
    expect(await noteRows()).toEqual([]);
  });

  it('a row not on the employee\'s timesheet is refused; an available-to-all indirect code is allowed', async () => {
    const stranger = await createTestChargeCode(clinId); // not assigned, no entries, no notes
    await expectFailure(saveTimesheetBatch({ periodStart: start, cells: [], notes: [{ chargeCodeId: stranger.id, dayIndex: 1, body: 'x', expectedRevision: 0 }] }), 'validation', /only add notes to rows on your timesheet/);
    const hidden = await createTestIndirectCode({ availableToAll: false });
    await expectFailure(saveTimesheetBatch({ periodStart: start, cells: [], notes: [{ indirectCodeId: hidden.id, dayIndex: 1, body: 'x', expectedRevision: 0 }] }), 'validation', /only add notes to rows/);
    await expectFailure(saveTimesheetBatch({ periodStart: start, cells: [], notes: [{ clinId, dayIndex: 1, body: 'x', expectedRevision: 0 }] }), 'validation', /only add notes to rows/);
    const leave = await createTestIndirectCode();
    await expectOk(saveTimesheetBatch({ periodStart: start, cells: [], notes: [{ indirectCodeId: leave.id, dayIndex: 1, body: 'Doctor', expectedRevision: 0 }] }));
    expect(await noteRows()).toHaveLength(1);
  });

  it('at most 1000 characters (after trimming); no notes on future dates', async () => {
    await expectOk(saveNote('a'.repeat(1000), 0));
    await expectFailure(saveNote('b'.repeat(1001), 1), 'validation', /at most 1000 characters/);
    const next = addDays(current, getNumDaysInPeriod(current, DEFAULT_PERIOD_CONFIG));
    await expectFailure(saveTimesheetBatch({ periodStart: next, cells: [], notes: [{ chargeCodeId: code.id, dayIndex: 0, body: 'x', expectedRevision: 0 }] }), 'validation', /future dates/);
    expect(await noteRows()).toHaveLength(1);
  });

  it('a stale expectedRevision is a conflict; nothing is written', async () => {
    await expectOk(saveNote('First', 0));
    await expectFailure(saveNote('Second tab', 0), 'conflict');
    expect((await noteRows()).map((r) => r.body)).toEqual(['First']);
  });

  it('M1: a stale expectedRevision is still a conflict when a hand-crafted request carries skipConflictCheck: true', async () => {
    await expectOk(saveNote('First', 0));
    const crafted = { periodStart: start, cells: [], notes: [{ chargeCodeId: code.id, dayIndex: 1, body: 'Overwrite', expectedRevision: 0 }], skipConflictCheck: true };
    await expectFailure(saveTimesheetBatch(crafted as Parameters<typeof saveTimesheetBatch>[0]), 'conflict');
    expect((await noteRows()).map((r) => r.body)).toEqual(['First']);
  });

  it('a note on a row whose assignment ended keeps the row (assignable: false) and can be cleared; a cleared note no longer does', async () => {
    await expectOk(saveNote('Kickoff', 0));
    await db().update(schema.userChargeCodes).set({ isActive: false }).where(eq(schema.userChargeCodes.userId, emp.id));
    const period = await getTimesheetPeriod(start);
    expect(period.chargeCodes.find((c) => c.id === code.id)).toMatchObject({ assignable: false });
    expect(period.notes[`${code.id}-1`]).toEqual({ body: 'Kickoff', revision: 1 });
    expect((await expectOk(saveNote('', 1))).noteRevisions).toEqual({ [`${code.id}-1`]: 2 });
    const after = await getTimesheetPeriod(start);
    expect(after.chargeCodes.find((c) => c.id === code.id)).toBeUndefined();
    expect(after.notes[`${code.id}-1`]).toEqual({ body: '', revision: 2 });
    // L3: eligibility follows what the grid shows — with only a cleared note left, the hidden row takes no new note.
    await expectFailure(saveTimesheetBatch({ periodStart: start, cells: [], notes: [{ chargeCodeId: code.id, dayIndex: 2, body: 'Back again', expectedRevision: 0 }] }), 'validation', /only add notes to rows on your timesheet/);
    await expectFailure(saveNote('Back again', 2), 'validation', /only add notes to rows on your timesheet/);
  });
});
