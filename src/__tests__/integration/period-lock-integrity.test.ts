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
        periodStart, // current period — draft (no row), passes assertPeriodEditable on its own
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: -1, hours: 4, isEdit: false, isLateEntry: false }],
      })
    ).rejects.toThrow(/Invalid day index/i);

    // Confirm nothing was written into the approved prior period.
    const lastDayOfPrevPeriod = dayjs(periodStart).subtract(1, 'day').toDate();
    const rows = await db.select().from(schema.timesheetEntries).where(
      and(eq(schema.timesheetEntries.userId, employee.id), eq(schema.timesheetEntries.chargeCodeId, chargeCode.id))
    );
    expect(rows).toHaveLength(0);
    void lastDayOfPrevPeriod;
  });

  it('a normal, in-bounds save still succeeds', async () => {
    const result = await saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: 0, hours: 6, isEdit: false, isLateEntry: false }],
    });
    expect(Object.keys(result)).toHaveLength(1);

    const db = getTestDb();
    const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].hours).toBe('6');
  });
});
