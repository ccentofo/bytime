import 'server-only';
import { getDb } from '@/db';
import { timesheetPeriods } from '@/db/schema';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { getNumDaysInPeriod, getPeriodStartForDate, type PeriodConfig } from '@/lib/date-utils';
import { addDays, compare, isBefore, isAfter, type CalendarDate } from '@/lib/calendar-date';
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
export async function getPeriodStatusFor(userId: string, periodStart: CalendarDate): Promise<PeriodInfo> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, periodStart),
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
 * Throws if ANY of `entryDates` falls on a day inside one of the user's submitted or approved
 * periods. This is the period-lock check for every timesheet write.
 *
 * It deliberately does not look the period up by the caller's periodStart: a caller could send
 * an entryDate that lands in a DIFFERENT (locked) period than the one it claims. Checking every
 * entry date against every nearby locked period closes that gap regardless of what periodStart
 * the caller claims.
 *
 * `numDaysFor` resolves a period's length for rows that predate the period_num_days snapshot.
 */
export async function assertEntryDatesEditable(
  userId: string,
  entryDates: CalendarDate[],
  numDaysFor: (periodStart: CalendarDate) => Promise<number>,
): Promise<void> {
  if (entryDates.length === 0) return;
  const minDay = entryDates.reduce((a, b) => (isBefore(b, a) ? b : a));
  const maxDay = entryDates.reduce((a, b) => (isAfter(b, a) ? b : a));

  // No period is longer than a month (31 days): a period that could contain minDay starts no
  // earlier than 31 days before it; a period starting exactly on maxDay must also be checked.
  const db = await getDb();
  const rows = await db
    .select({ periodStart: timesheetPeriods.periodStart, status: timesheetPeriods.status, periodNumDays: timesheetPeriods.periodNumDays })
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        inArray(timesheetPeriods.status, ['submitted', 'approved']),
        gte(timesheetPeriods.periodStart, addDays(minDay, -31)),
        lte(timesheetPeriods.periodStart, maxDay),
      )
    );

  for (const row of rows) {
    const start = row.periodStart as CalendarDate;
    const numDays = row.periodNumDays ?? (await numDaysFor(start));
    const end = addDays(start, numDays - 1);
    const hit = entryDates.find((d) => !isBefore(d, start) && !isAfter(d, end));
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
 * returns the same day. Just the config in effect AT the start is checked — D8's
 * updatePayPeriodConfig only allows a schedule change on a boundary common to both the old and
 * new schedules (§0.9), so there's no longer a "first period of the new schedule that actually
 * started under the old one" to special-case; every day belongs to exactly one period.
 */
export async function resolvePeriod(periodStart: CalendarDate): Promise<{ config: PeriodConfig; numDays: number }> {
  const config = await getEffectiveConfigAt(periodStart);
  if (compare(getPeriodStartForDate(periodStart, config), periodStart) === 0) {
    return { config, numDays: getNumDaysInPeriod(periodStart, config) };
  }
  throw new Error('Invalid period start date.');
}
