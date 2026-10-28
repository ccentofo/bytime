import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, getNumDaysInPeriod, navigatePeriod, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, diffDays, parseCalendarDate, todayIn, type CalendarDate } from '@/lib/calendar-date';
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

// ---------------------------------------------------------------------------
// R2-2: period-lock integrity. saveTimesheetBatch previously checked the lock only
// for the client-supplied periodStart and never bounded dayIndex — a periodStart
// that isn't a real period boundary (no period row → treated as draft by
// getPeriodStatusFor) or a dayIndex outside [0, numDays) could write a revision
// into a submitted/approved period without that period's own lock ever being
// checked.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
  // requireAdminFresh (updatePayPeriodConfig) re-reads the role through getDbForAuth.
  getDbForAuth: async () => getTestDb(),
}));

const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
}));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };

const sessionState = vi.hoisted(() => ({
  user: null as null | FakeSessionUser,
}));

vi.mock('@/auth', () => ({
  auth: async () =>
    sessionState.user
      ? {
          user: {
            id: sessionState.user.id,
            email: sessionState.user.email,
            fullName: sessionState.user.fullName,
            role: sessionState.user.role,
            tenantSlug: tenantState.requestSlug,
          },
        }
      : null,
}));

import { saveTimesheetBatch } from '@/server/actions/timesheet';
import { resolvePeriod } from '@/server/internal/periods';
import { updatePayPeriodConfig, getValidScheduleChangeDates, getNeighborPeriod } from '@/server/actions/pay-period-config';
import { getPeriodOptions } from '@/server/actions/periods';

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Period-lock integrity (R2-2)', () => {
  let employee: Awaited<ReturnType<typeof createTestUser>>;
  let chargeCode: Awaited<ReturnType<typeof createTestChargeCode>>;
  let periodStart: CalendarDate;
  let numDays: number;

  beforeEach(async () => {
    await cleanupTestData();
    const db = getTestDb();

    employee = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    chargeCode = await createTestChargeCode(clin.id);
    await db.insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: chargeCode.id, isActive: true });

    // workspace_settings seeds 'America/New_York' by default (migration 0011); this suite never
    // changes it, so fixtures compute "today" the same way the real actions do.
    periodStart = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    numDays = getNumDaysInPeriod(periodStart, DEFAULT_PERIOD_CONFIG);
    actingAs(employee);
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('rejects dayIndex = -1', async () => {
    await expectFailure(saveTimesheetBatch({
        expectedUserId: sessionState.user!.id,
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: -1, hours: 4, isEdit: false, isLateEntry: false }],
      }), 'validation', /Invalid day index/i);
  });

  it('rejects dayIndex = numDays (one past the last valid index)', async () => {
    await expectFailure(saveTimesheetBatch({
        expectedUserId: sessionState.user!.id,
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: numDays, hours: 4, isEdit: false, isLateEntry: false }],
      }), 'validation', /Invalid day index/i);
  });

  it('rejects a fractional dayIndex', async () => {
    await expectFailure(saveTimesheetBatch({
        expectedUserId: sessionState.user!.id,
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 1.5, hours: 4, isEdit: false, isLateEntry: false }],
      }), 'validation', /Invalid day index/i);
  });

  it('rejects a periodStart that is not a real period boundary', async () => {
    const bogusPeriodStart = addDays(periodStart, 3); // mid-period, not a boundary
    await expectFailure(saveTimesheetBatch({
        expectedUserId: sessionState.user!.id,
        periodStart: bogusPeriodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 0, hours: 4, isEdit: false, isLateEntry: false }],
      }), 'validation', /Invalid period start/i);
  });

  it('rejects writing into an approved prior period via a neighboring draft period (dayIndex underflow)', async () => {
    const db = getTestDb();
    const previousPeriodStart = navigatePeriod(periodStart, 'prev', DEFAULT_PERIOD_CONFIG);
    await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart: previousPeriodStart,
      status: 'approved',
      submittedAt: new Date(),
      reviewedAt: new Date(),
    });

    await expectFailure(saveTimesheetBatch({
        expectedUserId: sessionState.user!.id,
        periodStart, // current period — draft (no row)
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: -1, hours: 4, isEdit: false, isLateEntry: true }],
        // A valid reason code, so the late-entry rule can't be what rejects this.
        changeReasonCode: 'LATE_ENTRY',
      }), 'validation', /Invalid day index/i);

    // Confirm nothing was written into the approved prior period.
    const rows = await db.select().from(schema.timesheetEntries).where(
      and(eq(schema.timesheetEntries.userId, employee.id), eq(schema.timesheetEntries.chargeCodeId, chargeCode.id))
    );
    expect(rows).toHaveLength(0);
  });

  // The two tests formerly here ("sending its start at a different time of day" / "stored at a
  // browser-local midnight") exercised §0 problem 7 (exact-instant matches on a `timestamptz`
  // periodStart missing a same-day row stored under a different timezone's midnight). That bug
  // class is now structurally impossible: `timesheet_periods.periodStart` is a `date` column
  // holding a plain 'YYYY-MM-DD' CalendarDate with no time-of-day component to disagree about —
  // there is no "+1 second" or "+4 hours" value that TypeScript (or Postgres) will even accept.
  // This test covers the resulting invariant: an exact calendar-day match always finds the row.
  it('finds and locks an approved period by its exact calendar-day periodStart, with no timezone ambiguity possible', async () => {
    const db = getTestDb();
    const previousPeriodStart = navigatePeriod(periodStart, 'prev', DEFAULT_PERIOD_CONFIG);
    await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart: previousPeriodStart,
      status: 'approved',
      submittedAt: new Date(),
      reviewedAt: new Date(),
      periodNumDays: getNumDaysInPeriod(previousPeriodStart, DEFAULT_PERIOD_CONFIG),
    });

    await expectFailure(saveTimesheetBatch({
        expectedUserId: sessionState.user!.id,
        periodStart: previousPeriodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 2, hours: 4, isEdit: false, isLateEntry: true }],
        changeReasonCode: 'LATE_ENTRY',
      }), 'validation', /locked/i);

    const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, employee.id));
    expect(rows).toHaveLength(0);
  });

  // D8 §0.9: a schedule change is only accepted on a boundary common to BOTH the old and new
  // schedule, so there is no more "first period of the new schedule that actually started under
  // the old one" to special-case (that used to let one day belong to two periods at once).
  describe('schedule changes only land on a common boundary (§0.9)', () => {
    let admin: Awaited<ReturnType<typeof createTestUser>>;

    beforeEach(async () => {
      admin = await createTestUser({ role: 'admin' });
      // Fake only the clock: faking every timer can stall the Postgres driver.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 15, 12, 0, 0))); // 2026-01-15, mid-period noon UTC
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects an effective_from that is not a boundary of both schedules', async () => {
      actingAs(admin);
      // A biweekly schedule anchored on a date whose 14-day cycle does NOT line up with the
      // proposed effective_from — i.e. effective_from is a semimonthly boundary (the current
      // default schedule) but not a boundary of this new biweekly schedule.
      await expectFailure(updatePayPeriodConfig({
          periodType: 'biweekly',
          anchorDate: '2025-01-06' as CalendarDate, // a Monday
          weekStartDay: 1,
          effectiveFrom: '2026-03-01' as CalendarDate, // semimonthly boundary, not a Jan-6-anchored biweekly one
        }), 'validation', /boundary under both/i);
    });

    it('getValidScheduleChangeDates only offers dates valid under both schedules, and updatePayPeriodConfig accepts one', async () => {
      actingAs(admin);
      const validDates = await getValidScheduleChangeDates({
        periodType: 'biweekly',
        anchorDate: '2025-01-06' as CalendarDate,
        weekStartDay: 1,
      });
      expect(validDates.problem).toBeNull();
      expect(validDates.dates.length).toBeGreaterThan(0);

      const chosen = validDates.dates[0];
      const result = await expectOk(updatePayPeriodConfig({
        periodType: 'biweekly',
        anchorDate: '2025-01-06' as CalendarDate,
        weekStartDay: 1,
        effectiveFrom: chosen,
      }));
      expect(result.effectiveFrom).toBe(chosen);

      // No gap, no overlap: the day before effective_from resolves under the OLD (semimonthly)
      // schedule, and effective_from itself resolves under the NEW (biweekly) schedule — both
      // as their own clean period start, with no special-casing required.
      const dayBefore = addDays(parseCalendarDate(chosen), -1);
      const beforeResolved = await resolvePeriod(getPeriodStartForDate(dayBefore, DEFAULT_PERIOD_CONFIG));
      expect(beforeResolved.config.periodType).toBe(DEFAULT_PERIOD_CONFIG.periodType);

      const afterResolved = await resolvePeriod(chosen);
      expect(afterResolved.config.periodType).toBe('biweekly');
      expect(afterResolved.numDays).toBe(14);
    });

    it('rejects a weekly/biweekly anchor that does not fall on the selected week start day', async () => {
      actingAs(admin);
      await expectFailure(updatePayPeriodConfig({
          periodType: 'biweekly',
          anchorDate: '2025-01-07' as CalendarDate, // a Tuesday
          weekStartDay: 1, // Monday
          effectiveFrom: '2026-02-16' as CalendarDate,
        }), 'validation', /week start day/i);
    });

    it('rejects an unknown period type or week start day', async () => {
      actingAs(admin);
      await expectFailure(updatePayPeriodConfig({
        periodType: 'fortnightly' as never, anchorDate: '2026-01-05' as CalendarDate, weekStartDay: 1, effectiveFrom: '2026-02-16' as CalendarDate,
      }), 'validation', /Period type must be one of/);
      await expectFailure(updatePayPeriodConfig({
        periodType: 'weekly', anchorDate: '2026-01-05' as CalendarDate, weekStartDay: 9, effectiveFrom: '2026-02-16' as CalendarDate,
      }), 'validation', /Week start day/);
    });

    it('a workspace with no timesheets can apply a schedule immediately; once timesheets exist it cannot', async () => {
      actingAs(admin);
      const sundayWeekly = { periodType: 'weekly' as const, anchorDate: '2026-01-04' as CalendarDate, weekStartDay: 0 };

      const before = await getValidScheduleChangeDates(sundayWeekly);
      expect(before.immediate).toBe(true);
      expect(await expectOk(updatePayPeriodConfig({ ...sundayWeekly, effectiveFrom: null }))).toEqual({ effectiveFrom: null });
      const applied = await resolvePeriod('2026-01-11' as CalendarDate);
      expect(applied.config.periodType).toBe('weekly');
      expect(applied.numDays).toBe(7);

      // Now there is timesheet data: changes must be scheduled for a future common boundary.
      await getTestDb().insert(schema.timesheetEntries).values({
        userId: employee.id, chargeCodeId: chargeCode.id, entryDate: '2026-01-12', hours: '8', revisionNumber: 1, createdBy: employee.id,
      });
      const after = await getValidScheduleChangeDates(sundayWeekly);
      expect(after.immediate).toBe(false);
      await expectFailure(updatePayPeriodConfig({ ...sundayWeekly, effectiveFrom: null }), 'validation', /must start on a future date/);
    });

    it('explains a change that can never be scheduled instead of offering nothing silently', async () => {
      actingAs(admin);
      const db = getTestDb();
      await db.insert(schema.payPeriodConfig).values({
        periodType: 'weekly', anchorDate: '2026-01-05', weekStartDay: 1, effectiveFrom: '1900-01-01',
      });
      await db.insert(schema.timesheetEntries).values({
        userId: employee.id, chargeCodeId: chargeCode.id, entryDate: '2026-01-12', hours: '8', revisionNumber: 1, createdBy: employee.id,
      });
      // Monday weeks → Sunday weeks: no day is a period start under both, ever.
      const options = await getValidScheduleChangeDates({ periodType: 'weekly', anchorDate: '2026-01-04' as CalendarDate, weekStartDay: 0 });
      expect(options.immediate).toBe(false);
      expect(options.dates).toEqual([]);
      expect(options.problem).toMatch(/no date in the next two years/i);
    });
  });

  // Stepping by "one period of the current schedule" skipped periods when moving back from a
  // longer schedule into a shorter one (semimonthly Nov 16 − 1 period = Nov 1 → weekly Oct 26,
  // hiding the Nov 2 and Nov 9 weeks).
  describe('period navigation across a schedule change', () => {
    // UX-3 A4.6: getNeighborPeriod('next') stops at the period containing the workspace's today, so pin the clock after
    // these (otherwise future) periods. Clock only: faking all timers stalls the Postgres driver.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-12-15T17:00:00Z'));
    });
    afterEach(() => { vi.useRealTimers(); });
    beforeEach(async () => {
      const db = getTestDb();
      await db.insert(schema.payPeriodConfig).values([
        { periodType: 'weekly', anchorDate: '2026-01-05', weekStartDay: 1, effectiveFrom: '1900-01-01' },
        { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '2026-11-16' },
      ]);
    });

    it('the prev arrow from the first new period lands on the last old one, and next comes back', async () => {
      const prev = await getNeighborPeriod('2026-11-16' as CalendarDate, 'prev');
      expect(prev).toMatchObject({ periodStart: '2026-11-09', numDays: 7 });
      const next = await getNeighborPeriod('2026-11-09' as CalendarDate, 'next');
      expect(next).toMatchObject({ periodStart: '2026-11-16', numDays: 15 });
    });

    it('the period list includes every period across the change', async () => {
      const options = await getPeriodOptions('2026-11-16' as CalendarDate, 3, 1);
      expect(options.map((o) => o.start)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-12-01']);
    });

    it('caps how many periods one call may build', async () => {
      await expect(getPeriodOptions('2026-11-16' as CalendarDate, 61, 0)).rejects.toThrow(/0 to 60/);
      await expect(getPeriodOptions('2026-11-16' as CalendarDate, 0, 1e9)).rejects.toThrow(/0 to 60/);
    });
  });

  it('a normal, in-bounds save still succeeds', async () => {
    // Today's cell: neither late nor an edit, so no reason code is needed.
    const todayIndex = diffDays(periodStart, todayIn('America/New_York'));
    const result = await expectOk(saveTimesheetBatch({
      expectedUserId: sessionState.user!.id,
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 6, isEdit: false, isLateEntry: false }],
    }));
    expect(Object.keys(result.revisions)).toHaveLength(1); // UX-3 A4.2: the result is { revisions, noteRevisions }
    expect(result.noteRevisions).toEqual({});

    const db = getTestDb();
    const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].hours).toBe('6');
  });
});
