import { addDays, dayOfWeek, isAfter, type CalendarDate } from '@/lib/calendar-date';

/**
 * Workweek (FLSA) totals for a pay period (feature-plan-ux-timesheet.md A4.6). Pure and client-safe. Weeks follow the
 * workspace workweek (`workweekStartDay`, 0 = Sunday; null → Sunday), not the period's edges: the period's first and
 * last weeks are completed with the server's `outsideWeekHours` (the days of those weeks outside the period).
 */

/** The start of the workweek containing `day`. */
export function workweekStartOf(day: CalendarDate, workweekStartDay: number | null): CalendarDate {
  const ws = workweekStartDay ?? 0;
  return addDays(day, -((dayOfWeek(day) - ws + 7) % 7));
}

/** The days of the period's first and last workweeks that fall OUTSIDE the period (what `outsideWeekHours` covers). */
export function outsideWeekDates(start: CalendarDate, numDays: number, workweekStartDay: number | null): CalendarDate[] {
  const end = addDays(start, numDays - 1);
  const out: CalendarDate[] = [];
  for (let d = workweekStartOf(start, workweekStartDay); d < start; d = addDays(d, 1)) out.push(d);
  const lastWeekEnd = addDays(workweekStartOf(end, workweekStartDay), 6);
  for (let d = addDays(end, 1); d <= lastWeekEnd; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface WeekTotal {
  weekStart: CalendarDate;
  total: number;
  /** All 7 days are known (in the period or in outsideWeekHours) and none is after today. */
  complete: boolean;
  /** max(0, total − 40) for a complete week; 0 otherwise. */
  overtime: number;
}

/**
 * One row per workweek touching the period. A week is "under 40" (or has overtime) only when it's complete — a week
 * still in progress, or one whose outside days are unknown, is never flagged.
 */
export function weeklyTotals(
  periodDays: CalendarDate[],
  hoursByDate: Record<string, number>,
  outsideWeekHours: Record<string, number>,
  workweekStartDay: number | null,
  today: CalendarDate,
): WeekTotal[] {
  if (periodDays.length === 0) return [];
  const inPeriod = new Set<string>(periodDays);
  const starts = [...new Set(periodDays.map((d) => workweekStartOf(d, workweekStartDay)))].sort();
  return starts.map((weekStart) => {
    let total = 0;
    let known = true;
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      if (inPeriod.has(d)) total += hoursByDate[d] ?? 0;
      else if (d in outsideWeekHours) total += outsideWeekHours[d];
      else known = false;
    }
    total = Math.round(total * 100) / 100;
    const complete = known && !isAfter(addDays(weekStart, 6), today);
    return { weekStart, total, complete, overtime: complete ? Math.max(0, Math.round((total - 40) * 100) / 100) : 0 };
  });
}

/** Complete weeks under 40 hours (the "fewer than 40 hours" notice). */
export function weeksUnder40(weeks: WeekTotal[]): WeekTotal[] {
  return weeks.filter((w) => w.complete && w.total < 40);
}
