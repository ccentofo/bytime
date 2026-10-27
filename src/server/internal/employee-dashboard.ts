import 'server-only';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { timesheetEntries, timesheetPeriods } from '@/db/schema';
import { getLastWeekdayInPeriod, type PeriodConfig } from '@/lib/date-utils';
import { addDays, dayOfWeek, formatCalendarDate, isAfter, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { LATEST_REVISION } from './cost-basis';

export interface CurrentPeriodSummary {
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  periodLabel: string;
  status: string;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewComment: string | null;
  totalHoursEntered: number;
  /** Mon–Fri days in the period up to and including today. */
  expectedWorkdays: number;
  /** Days with hours > 0 (a cleared, zero-hour cell is not a day with entries). */
  daysWithEntries: number;
  /** Mon–Fri days up to today with hours > 0 — never more than expectedWorkdays. */
  workdaysFilled: number;
  daysRemaining: number;
  submissionDeadline: string;
  canSubmitToday: boolean;
  /** Latest-revision hours per day ('YYYY-MM-DD' → hours), days with no rows omitted. */
  dailyHours: Record<string, number>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isWeekday = (d: CalendarDate) => { const dow = dayOfWeek(d); return dow >= 1 && dow <= 5; };

/**
 * One person's current-period summary (feature-plan-ux-navigation-home.md §4.5.1), moved out of the
 * getEmployeeDashboardData action so Home can use it with its own resolved period. Hours are summed PER DAY over
 * latest revisions (all codes), so zero-hour days don't count as filled. INTERNAL, no guard: the caller authorizes.
 */
export async function currentPeriodSummary(
  db: Pick<ReadDb, 'select'>,
  userId: string,
  period: { start: CalendarDate; numDays: number; config: PeriodConfig },
  today: CalendarDate,
): Promise<CurrentPeriodSummary> {
  const start = period.start;
  const end = addDays(start, period.numDays - 1);
  const endExclusive = addDays(start, period.numDays);
  const [periodRows, perDay] = await Promise.all([
    db.select().from(timesheetPeriods).where(and(eq(timesheetPeriods.userId, userId), eq(timesheetPeriods.periodStart, start))),
    db.select({
      day: timesheetEntries.entryDate,
      hours: sql<string>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
    })
      .from(timesheetEntries)
      .where(and(eq(timesheetEntries.userId, userId), gte(timesheetEntries.entryDate, start), lt(timesheetEntries.entryDate, endExclusive), LATEST_REVISION))
      .groupBy(timesheetEntries.entryDate),
  ]);

  const dailyHours: Record<string, number> = {};
  for (const r of perDay) dailyHours[r.day] = round2(Number(r.hours));
  const filledDays = Object.entries(dailyHours).filter(([, h]) => h > 0).map(([d]) => d as CalendarDate);

  let expectedWorkdays = 0;
  let daysRemaining = 0;
  for (let i = 0; i < period.numDays; i++) {
    const date = addDays(start, i);
    if (!isWeekday(date)) continue;
    if (isAfter(date, today)) daysRemaining++;
    else expectedWorkdays++;
  }
  const lastWeekday = getLastWeekdayInPeriod(start, period.config);
  const row = periodRows[0];
  return {
    periodStart: start,
    periodEnd: end,
    periodLabel: `${formatCalendarDate(start, 'MMM D')} – ${formatCalendarDate(end, 'MMM D, YYYY')}`,
    status: row?.status ?? 'draft',
    submittedAt: row?.submittedAt ?? null,
    reviewedAt: row?.reviewedAt ?? null,
    reviewComment: row?.reviewComment ?? null,
    totalHoursEntered: round2(Object.values(dailyHours).reduce((s, h) => s + h, 0)),
    expectedWorkdays,
    daysWithEntries: filledDays.length,
    workdaysFilled: filledDays.filter((d) => isWeekday(d) && !isAfter(d, today)).length,
    daysRemaining,
    submissionDeadline: formatCalendarDate(lastWeekday, 'MMM D, YYYY'),
    canSubmitToday: !isBefore(today, lastWeekday),
    dailyHours,
  };
}
