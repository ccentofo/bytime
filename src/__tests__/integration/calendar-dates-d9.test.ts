import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { formatInstant, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  assignUserToClin,
  cleanupTestData,
  expectOk,
  expectFailure,
} from './helpers';

// ---------------------------------------------------------------------------
// D9: tests that can't be fooled by the dev machine's (or CI runner's) timezone —
// see feature-plan-calendar-dates.md §0 for the bugs these guard against.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
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

vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendDailyReminderEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendSubmissionDeadlineEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendPasswordResetEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
}));

import { saveTimesheetBatch } from '@/server/actions/timesheet';
import { submitPeriod, getPeriodOptions } from '@/server/actions/periods';
import { getDetailedCostReport } from '@/server/actions/reports';
import { resolvePeriod } from '@/server/internal/periods';

function actingAs(user: { id: string; role: string; email: string; fullName: string }) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('D9 — calendar-date correctness regardless of clock/timezone', () => {
  afterEach(async () => {
    sessionState.user = null;
    vi.useRealTimers();
    await cleanupTestData();
  });

  // -------------------------------------------------------------------------
  it('grid length (numDays) is correct for every period type', async () => {
    await cleanupTestData();
    const user = await createTestUser();
    actingAs(user);
    const configs: Array<{ periodType: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'; anchorDate: string; weekStartDay: number; probe: CalendarDate; expectedNumDays: number }> = [
      { periodType: 'weekly', anchorDate: '2026-01-05', weekStartDay: 1, probe: '2026-01-05' as CalendarDate, expectedNumDays: 7 },
      { periodType: 'biweekly', anchorDate: '2026-01-05', weekStartDay: 1, probe: '2026-01-05' as CalendarDate, expectedNumDays: 14 },
      { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, probe: '2026-01-01' as CalendarDate, expectedNumDays: 15 }, // 1st–15th
      { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, probe: '2026-01-16' as CalendarDate, expectedNumDays: 16 }, // 16th–31st (31-day month)
      { periodType: 'monthly', anchorDate: '2026-01-01', weekStartDay: 1, probe: '2026-02-01' as CalendarDate, expectedNumDays: 28 }, // Feb 2026 (not a leap year)
    ];

    for (const c of configs) {
      const db = getTestDb();
      const [row] = await db.insert(schema.payPeriodConfig).values({
        periodType: c.periodType, anchorDate: c.anchorDate, weekStartDay: c.weekStartDay, effectiveFrom: '2020-01-01',
      }).returning();
      try {
        const { numDays } = await resolvePeriod(c.probe);
        expect(numDays, `${c.periodType} @ ${c.probe}`).toBe(c.expectedNumDays);
      } finally {
        await db.delete(schema.payPeriodConfig).where(eq(schema.payPeriodConfig.id, row.id));
      }
    }
  });

  // -------------------------------------------------------------------------
  it('biweekly: getPeriodOptions and save/submit both work for the current period', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const employee = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);
    await assignUserToClin(employee.id, clin.id);
    await db.insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: chargeCode.id, isActive: true });

    // 2026-01-05 is a Monday; biweekly period runs 2026-01-05..2026-01-18 (14 days).
    const [config] = await db.insert(schema.payPeriodConfig).values({
      periodType: 'biweekly', anchorDate: '2026-01-05', weekStartDay: 1, effectiveFrom: '2020-01-01',
    }).returning();

    try {
      // Fake "now" to the last day of that period (Sun Jan 18, noon Eastern) — on/after the last
      // weekday (Fri Jan 16), so submission is allowed.
      vi.useFakeTimers({ toFake: ['Date'] }); // clock only: faking all timers stalls the Postgres driver
      vi.setSystemTime(new Date('2026-01-18T17:00:00Z'));

      actingAs(employee);
      const periodStart = '2026-01-05' as CalendarDate;
      const options = await getPeriodOptions(periodStart, 1, 1);
      expect(options.length).toBe(3);
      for (const o of options) expect(o.numDays).toBe(14);
      expect(options.map((o) => o.start)).toContain(periodStart);

      await expectOk(saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 13, hours: 8, isEdit: false, isLateEntry: false }],
      }));
      await expectOk(submitPeriod({ periodStart }));

      const [period] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.userId, employee.id));
      expect(period.status).toBe('submitted');
      expect(period.periodNumDays).toBe(14);
    } finally {
      await db.delete(schema.payPeriodConfig).where(eq(schema.payPeriodConfig.id, config.id));
    }
  });

  // -------------------------------------------------------------------------
  it('after 8pm Eastern, entering TODAY\'s hours needs no late-entry reason (§0 problem 5)', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const employee = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);
    await assignUserToClin(employee.id, clin.id);
    await db.insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: chargeCode.id, isActive: true });

    try {
      // 10pm Eastern on Jan 15 2026 is 3am UTC on Jan 16. A server that used UTC "today" would
      // think today is Jan 16, making an entry for Jan 15 look like a late (yesterday) entry.
      vi.useFakeTimers({ toFake: ['Date'] }); // clock only: faking all timers stalls the Postgres driver
      vi.setSystemTime(new Date('2026-01-16T03:00:00Z'));

      actingAs(employee);
      const periodStart = '2026-01-01' as CalendarDate; // semimonthly default, 1st–15th
      await expectOk(saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 14, hours: 8, isEdit: false, isLateEntry: false }], // day 14 = Jan 15
      }));

      const [row] = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id));
      expect(row.entryDate).toBe('2026-01-15');
      expect(row.changeReasonCode).toBeNull(); // no reason required — today's entry, not late
    } finally {
      // nothing to clean up beyond the standard afterEach
    }
  });

  // -------------------------------------------------------------------------
  it('rejects a future-dated entry (tomorrow in the workspace timezone), accepts today', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const employee = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);
    await assignUserToClin(employee.id, clin.id);
    await db.insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: chargeCode.id, isActive: true });

    try {
      vi.useFakeTimers({ toFake: ['Date'] }); // clock only: faking all timers stalls the Postgres driver
      // Noon Eastern, Jan 14: "tomorrow" (Jan 15) is still inside the Jan 1–15 period (day 14),
      // so the future-date rule, not the day-index bound, is what rejects it.
      vi.setSystemTime(new Date('2026-01-14T17:00:00Z'));

      actingAs(employee);
      const periodStart = '2026-01-01' as CalendarDate;

      await expectFailure(saveTimesheetBatch({
          periodStart,
          cells: [{ chargeCodeId: chargeCode.id, dayIndex: 14, hours: 8, isEdit: false, isLateEntry: false }], // day 14 = Jan 15 (tomorrow)
        }), 'validation', /future date/i);

      await expectOk(saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: 13, hours: 8, isEdit: false, isLateEntry: false }], // day 13 = Jan 14 (today)
      }));
      const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id));
      expect(rows).toHaveLength(1);
    } finally {
      // nothing to clean up beyond the standard afterEach
    }
  });

  // -------------------------------------------------------------------------
  it('report totals do not double-count after an edit (latest revision only)', async () => {
    await cleanupTestData();
    const admin = await createTestUser({ role: 'admin' });
    const employee = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);
    await assignUserToClin(employee.id, clin.id);
    const db = getTestDb();
    await db.insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: chargeCode.id, isActive: true });

    vi.useFakeTimers({ toFake: ['Date'] }); // clock only: faking all timers stalls the Postgres driver
    vi.setSystemTime(new Date('2026-01-05T17:00:00Z')); // noon Eastern, Jan 5 — same day as the entry

    actingAs(employee);
    const periodStart = '2026-01-01' as CalendarDate;
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: 4, hours: 8, isEdit: false, isLateEntry: false }],
    }));
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: 4, hours: 5, isEdit: true, isLateEntry: false }],
      changeReasonCode: 'CORRECTION',
    }));

    actingAs(admin);
    const report = await getDetailedCostReport('2026-01-01' as CalendarDate, '2026-01-31' as CalendarDate);
    const totalHoursForDay = report
      .filter((r) => r.entryDate === '2026-01-05')
      .reduce((sum, r) => sum + r.totalHours, 0);
    expect(totalHoursForDay).toBe(5); // only the latest revision (5), never 8 + 5
  });

  // -------------------------------------------------------------------------
  it('formatInstant includes the zone abbreviation, for unambiguous PDF/email timestamps', () => {
    // EST (standard time) in January — never ambiguous about which timezone a legal-record
    // timestamp is in, unlike the old UTC-wall-clock-with-no-label format.
    const winter = formatInstant(new Date('2026-01-15T17:00:00Z'), 'America/New_York', 'MMM D, YYYY h:mm A');
    expect(winter).toMatch(/EST$/);

    // EDT (daylight time) in July.
    const summer = formatInstant(new Date('2026-07-15T17:00:00Z'), 'America/New_York', 'MMM D, YYYY h:mm A');
    expect(summer).toMatch(/EDT$/);
  });
});
