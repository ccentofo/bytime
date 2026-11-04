import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';

/**
 * The empty-download message (feature-plan-ux-kit-contracts.md R4): a report whose total hours are 0 returns 422 with
 * this text, and the Downloads page shows it in place. The reports aren't limited to approved hours, so it never says
 * "approved"; the hours summary counts direct time only, so it says "direct".
 */

/** "Oct 16 and Oct 31, 2026"; across years, both years ("Dec 16, 2025 and Jan 15, 2026"). */
export function betweenWords(start: CalendarDate, end: CalendarDate): string {
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${formatCalendarDate(start, 'MMM D')} and ${formatCalendarDate(end, 'MMM D, YYYY')}`
    : `${formatCalendarDate(start, 'MMM D, YYYY')} and ${formatCalendarDate(end, 'MMM D, YYYY')}`;
}

export function noHoursMessage(start: CalendarDate, end: CalendarDate, opts: { direct?: boolean } = {}): string {
  return `No ${opts.direct ? 'direct ' : ''}hours recorded between ${betweenWords(start, end)}.`;
}

/** True when the rows' hours total 0 to the cent (cleared-only ranges included). */
export function noHours<T>(rows: T[], hoursOf: (row: T) => number): boolean {
  return Math.round(rows.reduce((s, r) => s + Number(hoursOf(r) || 0), 0) * 100) === 0;
}
