import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import type { ChargeCode, PeriodStatus } from '@/types/timesheet';

/** Timesheet labels (feature-plan-ux-timesheet-ui.md §4.1, §4.2). Pure. */

/** The status word, shown once in the header and read in the grid caption. */
export const STATUS_WORD: Record<PeriodStatus, string> = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Returned' };

/** The visible period label: "Oct 16 – 31, 2026", "Sep 28 – Oct 4, 2026", "Dec 16, 2026 – Jan 1, 2027". */
export function periodLabel(start: CalendarDate, end: CalendarDate): string {
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${formatCalendarDate(start, 'MMM D, YYYY')} – ${formatCalendarDate(end, 'MMM D, YYYY')}`;
  if (start.slice(0, 7) !== end.slice(0, 7)) return `${formatCalendarDate(start, 'MMM D')} – ${formatCalendarDate(end, 'MMM D, YYYY')}`;
  return `${formatCalendarDate(start, 'MMM D')} – ${formatCalendarDate(end, 'D, YYYY')}`;
}

/** The same range in words, for the grid caption: "Oct 16 to 31, 2026". */
export function periodWords(start: CalendarDate, end: CalendarDate): string {
  return periodLabel(start, end).replace(' – ', ' to ');
}

/**
 * A row's name as shown next to its code — empty when it just repeats the code (a legacy CLIN without a description is
 * "CLIN 0001" / "CLIN 0001"), so it isn't shown twice (UX-TIMESHEET-B-AUDIT L13).
 */
export function shownRowName(cc: Pick<ChargeCode, 'clin' | 'name'>): string {
  return cc.name.trim() === cc.clin.trim() ? '' : cc.name;
}

/** "{code} {rowName}", or just the code when the name repeats it (L13). */
export function rowLabel(cc: Pick<ChargeCode, 'clin' | 'name'>): string {
  const name = shownRowName(cc);
  return name ? `${cc.clin} ${name}` : cc.clin;
}
