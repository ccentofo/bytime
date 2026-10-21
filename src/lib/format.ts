import { formatCalendarDate, formatInstant, type CalendarDate } from '@/lib/calendar-date';

/** Display a calendar date, e.g. "Jun 12, 2026". Never pass a raw `Date`/instant here — use `formatDateTime`. */
export const formatDate = (d: CalendarDate | null | undefined) =>
  d ? formatCalendarDate(d, 'MMM D, YYYY') : '—';

/**
 * Display an instant (created_at, submitted_at, connected_at, …) in the given IANA timezone,
 * with the zone abbreviation appended — e.g. "Jun 12, 2026 3:45 PM EDT". Legal-record timestamps
 * must be unambiguous about which timezone they're in; `timeZone` should be the workspace's.
 */
export const formatDateTime = (d: Date | null | undefined, timeZone: string) =>
  d ? formatInstant(d, timeZone, 'MMM D, YYYY h:mm A') : '—';

/** Short display date (no year), e.g. "Jun 12". For compact contexts like chart axes. */
export const formatShortDate = (d: CalendarDate | null | undefined) =>
  d ? formatCalendarDate(d, 'MMM D') : '—';
