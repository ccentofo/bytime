import 'server-only';
import { eq } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { users } from '@/db/schema';
import { getLastWeekdayInPeriod, type PeriodConfig } from '@/lib/date-utils';
import { calendarDayOf, isAfter, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { outsideWeekDates } from '@/lib/timesheet/weekly';
import { loadScheduleResolver } from './pay-period-config';
import { currentPeriodSummary, type CurrentPeriodSummary } from './employee-dashboard';
import { workweekStartDayInternal } from './workspace-settings';
import { latestDayTotals } from './day-totals';

type Reader = Pick<ReadDb, 'select'>;

export interface RequestedPeriod { start: CalendarDate; numDays: number; config: PeriodConfig; isCurrent: boolean }

/**
 * The period a request asks for (feature-plan-ux-timesheet.md A4.6, `?period=` / navigation): an array takes its first
 * element; anything that isn't a calendar date means the current period; a date snaps to the period containing it
 * (imported periods are always on-schedule); a future period is clamped to the current one. Never throws.
 * INTERNAL, no guard: callers authorize first.
 */
export async function resolveRequestedPeriod(db: Reader, raw: string | string[] | undefined, today: CalendarDate): Promise<RequestedPeriod> {
  const resolver = await loadScheduleResolver(db);
  const current = resolver.periodContaining(today);
  const value = Array.isArray(raw) ? raw[0] : raw;
  const period = isCalendarDate(value) ? resolver.periodContaining(value) : current;
  const chosen = isAfter(period.start, current.start) ? current : period;
  return { start: chosen.start, numDays: chosen.numDays, config: chosen.config, isCurrent: chosen.start === current.start };
}

export interface SelectedPeriodFacts {
  summary: CurrentPeriodSummary;
  /** The day Submit opens: the period's last weekday (the same rule as the toolbar and submitPeriod). */
  submitOpensOn: CalendarDate;
  workweekStartDay: number | null;
  /** Latest-revision hours for the days of the period's first and last workweeks outside the period (0 if none). */
  outsideWeekHours: Record<string, number>;
  /** The user's creation day in the workspace timezone. */
  userCreatedOn: CalendarDate;
  /** feature-plan-ux-timesheet-ui.md §4.14: when the period was submitted / last reviewed, as workspace calendar days. */
  submittedOn: CalendarDate | null;
  reviewedOn: CalendarDate | null;
}

/**
 * What the timesheet screen needs about the SELECTED period beyond its entries (A4.6). Own data only: the caller
 * passes the session user's id. INTERNAL, no guard.
 */
export async function selectedPeriodFacts(
  db: Reader,
  userId: string,
  period: { start: CalendarDate; numDays: number; config: PeriodConfig },
  today: CalendarDate,
  timeZone: string,
): Promise<SelectedPeriodFacts> {
  const [summary, workweekStartDay, [user]] = await Promise.all([
    currentPeriodSummary(db, userId, period, today),
    workweekStartDayInternal(db),
    db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  const outside = outsideWeekDates(period.start, period.numDays, workweekStartDay);
  const totals = await latestDayTotals(db, userId, outside);
  const outsideWeekHours: Record<string, number> = {};
  for (const d of outside) outsideWeekHours[d] = totals[d] ?? 0;
  return {
    summary,
    submitOpensOn: getLastWeekdayInPeriod(period.start, period.config),
    workweekStartDay,
    outsideWeekHours,
    userCreatedOn: calendarDayOf(user?.createdAt ?? new Date(), timeZone),
    submittedOn: summary.submittedAt ? calendarDayOf(summary.submittedAt, timeZone) : null,
    reviewedOn: summary.reviewedAt ? calendarDayOf(summary.reviewedAt, timeZone) : null,
  };
}
