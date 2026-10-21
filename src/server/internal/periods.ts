import 'server-only';
import { getDb } from '@/db';
import { timesheetPeriods, payPeriodConfig } from '@/db/schema';
import { eq, and, gt, gte, lt, desc, inArray } from 'drizzle-orm';
import dayjs from 'dayjs';
import { getNumDaysInPeriod, getPeriodStartForDate, type PeriodConfig, type PeriodType } from '@/lib/date-utils';
import { getEffectiveConfigAt } from '@/server/actions/pay-period-config';

export type PeriodStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface PeriodInfo {
  id: string | null;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewComment: string | null;
  periodType: string | null;
  periodNumDays: number | null;
}

/**
 * Get the period status for an arbitrary user and period start date. Returns draft if no record
 * exists yet.
 *
 * INTERNAL — not a server action. Used by saveTimesheetBatch's period-lock check (which already
 * validated the actor owns the entry) and by the self-only getPeriodStatus() action in
 * src/server/actions/periods.ts.
 */
export async function getPeriodStatusFor(userId: string, periodStart: Date): Promise<PeriodInfo> {
  const db = await getDb();
  const [dayFrom, dayTo] = calendarDayWindow(periodStart);
  const rows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        gte(timesheetPeriods.periodStart, dayFrom),
        lt(timesheetPeriods.periodStart, dayTo),
      )
    );

  if (rows.length === 0) {
    return {
      id: null,
      status: 'draft',
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
      periodType: null,
      periodNumDays: null,
    };
  }

  const row = rows[0];
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    reviewComment: row.reviewComment,
    periodType: row.periodType ?? null,
    periodNumDays: row.periodNumDays ?? null,
  };
}

/**
 * The calendar day a stored period/entry timestamp represents. Period starts reach the server
 * as "midnight" in whichever timezone computed them (browser-local from the period picker,
 * server-local from page load), so the same calendar day can arrive as different instants.
 * Rounding to the nearest midnight maps any of those back to one day for offsets under 12h.
 */
export function calendarDay(date: Date): dayjs.Dayjs {
  return dayjs(date).add(12, 'hour').startOf('day');
}

/** The [from, to) instant range whose timestamps all map to `date`'s calendarDay. */
export function calendarDayWindow(date: Date): [Date, Date] {
  const day = calendarDay(date);
  return [day.subtract(12, 'hour').toDate(), day.add(12, 'hour').toDate()];
}

/**
 * Throws if ANY of `entryDates` falls on a calendar day inside one of the user's submitted or
 * approved periods. This is the period-lock check for every timesheet write.
 *
 * It deliberately does not look the period up by the caller's periodStart: an exact-timestamp
 * lookup can be sidestepped by sending the same day at a different time (no row matches, so it
 * reads as an editable draft). Overlap by calendar day can't be.
 *
 * `numDaysFor` resolves a period's length for rows that predate the period_num_days snapshot.
 */
export async function assertEntryDatesEditable(
  userId: string,
  entryDates: Date[],
  numDaysFor: (periodStart: Date) => Promise<number>,
): Promise<void> {
  if (entryDates.length === 0) return;
  const days = entryDates.map(calendarDay);
  const minDay = days.reduce((a, b) => (b.isBefore(a) ? b : a));
  const maxDay = days.reduce((a, b) => (b.isAfter(a) ? b : a));

  // No period is longer than a month, so a 45-day lookback covers any period that could
  // contain minDay; the +36h upper bound covers a period starting on maxDay at any offset.
  const db = await getDb();
  const rows = await db
    .select({ periodStart: timesheetPeriods.periodStart, status: timesheetPeriods.status, periodNumDays: timesheetPeriods.periodNumDays })
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        inArray(timesheetPeriods.status, ['submitted', 'approved']),
        gte(timesheetPeriods.periodStart, minDay.subtract(45, 'day').toDate()),
        lt(timesheetPeriods.periodStart, maxDay.add(36, 'hour').toDate()),
      )
    );

  for (const row of rows) {
    const start = calendarDay(row.periodStart);
    const numDays = row.periodNumDays ?? (await numDaysFor(start.toDate()));
    const end = start.add(numDays, 'day');
    const hit = days.find((d) => !d.isBefore(start, 'day') && d.isBefore(end, 'day'));
    if (hit) {
      throw new Error(
        `Cannot modify a ${row.status} timesheet. This period has been certified and is locked. ` +
        `If a correction is required, the supervisor must reject the period first.`
      );
    }
  }
}

/**
 * Validate that `periodStart` is a real period start and return the pay-period config it
 * belongs to and its length in days.
 *
 * A period start is valid under a pay-period config if snapping it to that config's schedule
 * returns the same day, and the config is in effect at some point during the period. Two
 * configs are candidates: the one in effect AT the start, and any that takes effect within
 * the next month. The second case is the first period of a new schedule, which the timesheet
 * navigation (getNeighborPeriod) snaps under the new config even when it begins a few days
 * before the new config's effective date.
 */
export async function resolvePeriod(periodStart: Date): Promise<{ config: PeriodConfig; numDays: number }> {
  const db = await getDb();
  const startDay = calendarDay(periodStart);
  const candidates: PeriodConfig[] = [await getEffectiveConfigAt(periodStart)];
  const upcoming = await db
    .select()
    .from(payPeriodConfig)
    .where(and(gt(payPeriodConfig.effectiveFrom, periodStart), lt(payPeriodConfig.effectiveFrom, startDay.add(32, 'day').toDate())))
    .orderBy(payPeriodConfig.effectiveFrom, desc(payPeriodConfig.createdAt));
  for (const row of upcoming) {
    const config: PeriodConfig = { periodType: row.periodType as PeriodType, anchorDate: row.anchorDate, weekStartDay: row.weekStartDay };
    // Only counts if the new config takes effect before this period would end under it.
    if (dayjs(row.effectiveFrom).isBefore(startDay.add(getNumDaysInPeriod(startDay.toDate(), config), 'day'))) {
      candidates.push(config);
    }
  }

  for (const config of candidates) {
    if (calendarDay(getPeriodStartForDate(startDay.toDate(), config)).isSame(startDay, 'day')) {
      return { config, numDays: getNumDaysInPeriod(startDay.toDate(), config) };
    }
  }
  throw new Error('Invalid period start date.');
}
