import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dayjs from 'dayjs';
import { eq, and } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, getNumDaysInPeriod, navigatePeriod } from '@/lib/date-utils';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  cleanupTestData,
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

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Period-lock integrity (R2-2)', () => {
  let employee: Awaited<ReturnType<typeof createTestUser>>;
  let chargeCode: Awaited<ReturnType<typeof createTestChargeCode>>;
  let periodStart: Date;
  let numDays: number;

  beforeEach(async () => {
    await cleanupTestData();
    const db = getTestDb();

    employee = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    chargeCode = await createTestChargeCode(clin.id);
    await db.insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: chargeCode.id, isActive: true });

    periodStart = getPeriodStartForDate(new Date());
    numDays = getNumDaysInPeriod(periodStart);
    actingAs(employee);
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('rejects dayIndex = -1', async () => {
    await expect(
      saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: -1, hours: 4, isEdit: false, isLateEntry: false }],
      })
    ).rejects.toThrow(/Invalid day index/i);
  });

  it('rejects dayIndex = numDays (one past the last valid index)', async () => {
    await expect(
      saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: numDays, hours: 4, isEdit: false, isLateEntry: false }],
      })
    ).rejects.toThrow(/Invalid day index/i);
  });

  it('rejects a fractional dayIndex', async () => {
    await expect(
      saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 1.5, hours: 4, isEdit: false, isLateEntry: false }],
      })
    ).rejects.toThrow(/Invalid day index/i);
  });

  it('rejects a periodStart that is not a real period boundary', async () => {
    const bogusPeriodStart = dayjs(periodStart).add(3, 'day').toDate(); // mid-period, not a boundary
    await expect(
      saveTimesheetBatch({
        periodStart: bogusPeriodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 0, hours: 4, isEdit: false, isLateEntry: false }],
      })
    ).rejects.toThrow(/Invalid period start/i);
  });

  it('rejects writing into an approved prior period via a neighboring draft period (dayIndex underflow)', async () => {
    const db = getTestDb();
    const previousPeriodStart = navigatePeriod(periodStart, 'prev');
    await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart: previousPeriodStart,
      status: 'approved',
      submittedAt: new Date(),
      reviewedAt: new Date(),
    });

    await expect(
      saveTimesheetBatch({
        periodStart, // current period — draft (no row)
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: -1, hours: 4, isEdit: false, isLateEntry: true }],
        // A valid reason code, so the late-entry rule can't be what rejects this.
        changeReasonCode: 'LATE_ENTRY',
      })
    ).rejects.toThrow(/Invalid day index/i);

    // Confirm nothing was written into the approved prior period.
    const rows = await db.select().from(schema.timesheetEntries).where(
      and(eq(schema.timesheetEntries.userId, employee.id), eq(schema.timesheetEntries.chargeCodeId, chargeCode.id))
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects writing into an approved period by sending its start at a different time of day', async () => {
    const db = getTestDb();
    const previousPeriodStart = navigatePeriod(periodStart, 'prev');
    await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart: previousPeriodStart,
      status: 'approved',
      submittedAt: new Date(),
      reviewedAt: new Date(),
      periodNumDays: getNumDaysInPeriod(previousPeriodStart),
    });

    // Same calendar day, one second later: an exact-timestamp lookup finds no row and treats
    // the period as an editable draft.
    const offByOneSecond = dayjs(previousPeriodStart).add(1, 'second').toDate();
    await expect(
      saveTimesheetBatch({
        periodStart: offByOneSecond,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 0, hours: 4, isEdit: false, isLateEntry: true }],
        changeReasonCode: 'LATE_ENTRY',
      })
    ).rejects.toThrow(/locked/i);

    const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, employee.id));
    expect(rows).toHaveLength(0);
  });

  it('rejects writing into an approved period whose row was stored at a browser-local midnight', async () => {
    const db = getTestDb();
    const previousPeriodStart = navigatePeriod(periodStart, 'prev');
    // The period picker computes midnight in the browser's timezone, e.g. 04:00Z for New York.
    await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart: dayjs(previousPeriodStart).add(4, 'hour').toDate(),
      status: 'approved',
      submittedAt: new Date(),
      reviewedAt: new Date(),
      periodNumDays: getNumDaysInPeriod(previousPeriodStart),
    });

    await expect(
      saveTimesheetBatch({
        periodStart: previousPeriodStart, // server midnight
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 2, hours: 4, isEdit: false, isLateEntry: true }],
        changeReasonCode: 'LATE_ENTRY',
      })
    ).rejects.toThrow(/locked/i);
  });

  it('accepts the first period of a new pay schedule that starts before the change takes effect', async () => {
    const db = getTestDb();
    // Biweekly from Mon Jan 6 2025, effective Sat Nov 1 2025. The timesheet navigation snaps
    // the first new period to Mon Oct 27 2025 (it contains Nov 1), while the config in effect
    // AT Oct 27 is still the old semi-monthly one, whose period started Oct 16.
    const [newConfig] = await db.insert(schema.payPeriodConfig).values({
      periodType: 'biweekly',
      anchorDate: new Date(2025, 0, 6),
      weekStartDay: 1,
      effectiveFrom: new Date(2025, 10, 1),
    }).returning();
    try {
      const { config, numDays: length } = await resolvePeriod(new Date(2025, 9, 27));
      expect(config.periodType).toBe('biweekly');
      expect(length).toBe(14);
      // The old schedule's own boundary is still valid, and a mid-period date is not.
      expect((await resolvePeriod(new Date(2025, 9, 16))).config.periodType).toBe('semimonthly');
      await expect(resolvePeriod(new Date(2025, 9, 28))).rejects.toThrow(/Invalid period start/i);
    } finally {
      await db.delete(schema.payPeriodConfig).where(eq(schema.payPeriodConfig.id, newConfig.id));
    }
  });

  it('a normal, in-bounds save still succeeds', async () => {
    // Today's cell: neither late nor an edit, so no reason code is needed.
    const todayIndex = dayjs().startOf('day').diff(dayjs(periodStart).startOf('day'), 'day');
    const result = await saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 6, isEdit: false, isLateEntry: false }],
    });
    expect(Object.keys(result)).toHaveLength(1);

    const db = getTestDb();
    const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].hours).toBe('6');
  });
});
