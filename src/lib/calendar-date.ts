import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

// ---------------------------------------------------------------------------
// CalendarDate — see feature-plan-calendar-dates.md §1 (the model, LOCKED).
//
// A calendar date (entry day, period start, anchor, effective-from, contract/LCAT dates, sync
// range) is a 'YYYY-MM-DD' string end to end: DB column, server actions, RSC props, URLs, API.
// It is NEVER converted to a JS Date or an instant — all arithmetic here runs on dayjs objects
// constructed with `.utc(...)`, so results never depend on the process's local timezone. This
// file is a plain module (not 'use server') — the guard-coverage test bans re-exporting types
// from action files, and this type needs to be shared everywhere.
// ---------------------------------------------------------------------------

export type CalendarDate = string & { readonly __brand: 'CalendarDate' };

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True if `value` is a real calendar date in 'YYYY-MM-DD' form. Validates by round-tripping
 * through dayjs.utc and comparing the re-formatted string to the input — dayjs (like the native
 * Date it wraps) rolls an out-of-range date over (e.g. "2026-02-30" → "2026-03-02") rather than
 * rejecting it, so the round-trip is what actually catches it.
 */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string' || !CALENDAR_DATE_RE.test(value)) return false;
  const d = dayjs.utc(value);
  return d.isValid() && d.format('YYYY-MM-DD') === value;
}

/**
 * Validate and brand a calendar date. Throws on anything else. Call this at every trust
 * boundary: server action parameters, route params, API query strings.
 */
export function parseCalendarDate(value: unknown): CalendarDate {
  if (!isCalendarDate(value)) {
    const shown = typeof value === 'string' ? `"${value}"` : String(value);
    throw new Error(`Invalid calendar date: ${shown} is not a valid YYYY-MM-DD date.`);
  }
  return value;
}

function toUtc(d: CalendarDate): dayjs.Dayjs {
  return dayjs.utc(d);
}

function fromUtc(d: dayjs.Dayjs): CalendarDate {
  return d.format('YYYY-MM-DD') as CalendarDate;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function addDays(d: CalendarDate, n: number): CalendarDate {
  return fromUtc(toUtc(d).add(n, 'day'));
}

/** Exact integer day count from `a` to `b` (positive if `b` is after `a`). */
export function diffDays(a: CalendarDate, b: CalendarDate): number {
  return toUtc(b).diff(toUtc(a), 'day');
}

/** 0 (Sunday) – 6 (Saturday). */
export function dayOfWeek(d: CalendarDate): number {
  return toUtc(d).day();
}

/** 1–31. */
export function dayOfMonth(d: CalendarDate): number {
  return toUtc(d).date();
}

export function daysInMonth(d: CalendarDate): number {
  return toUtc(d).daysInMonth();
}

export function startOfMonth(d: CalendarDate): CalendarDate {
  return fromUtc(toUtc(d).date(1));
}

/** Set the day-of-month. Overflows into the next month if `day` exceeds the month's length,
 *  same as native Date.setDate — callers that need the "1st or 16th" boundaries never overflow. */
export function withDayOfMonth(d: CalendarDate, day: number): CalendarDate {
  return fromUtc(toUtc(d).date(day));
}

/** Adds calendar months, clamping to the target month's last day (Jan 31 + 1mo = Feb 28/29). */
export function addMonths(d: CalendarDate, n: number): CalendarDate {
  return fromUtc(toUtc(d).add(n, 'month'));
}

// ---------------------------------------------------------------------------
// Comparison — plain string comparison is correct here: zero-padded 'YYYY-MM-DD' sorts
// identically to chronological order, so there's no need to round-trip through dayjs.
// ---------------------------------------------------------------------------

export function compare(a: CalendarDate, b: CalendarDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isBefore(a: CalendarDate, b: CalendarDate): boolean {
  return a < b;
}

export function isAfter(a: CalendarDate, b: CalendarDate): boolean {
  return a > b;
}

export function max(...dates: CalendarDate[]): CalendarDate {
  if (dates.length === 0) throw new Error('max() requires at least one CalendarDate.');
  return dates.reduce((m, d) => (d > m ? d : m));
}

export function min(...dates: CalendarDate[]): CalendarDate {
  if (dates.length === 0) throw new Error('min() requires at least one CalendarDate.');
  return dates.reduce((m, d) => (d < m ? d : m));
}

// ---------------------------------------------------------------------------
// Timezone-aware "today" and formatting
// ---------------------------------------------------------------------------

/**
 * The canonical IANA name for `tz` (e.g. `america/new_york` → `America/New_York`), or null if it
 * isn't a region-style IANA zone. Rejects non-strings (Intl would coerce `['UTC']` to a string),
 * abbreviations (`EST`), and raw offsets (`+05:00`): they're ambiguous or ignore DST.
 */
export function canonicalTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return null;
  // Judge the INPUT, not just Intl's result: ICU silently maps abbreviations to some region
  // (e.g. "EST" → America/Panama, which has no daylight saving time), and Etc/GMT±N zones have
  // inverted signs. Only Region/City names and UTC are accepted.
  const isUtc = /^(?:Etc\/)?UTC$/i.test(tz);
  if (!isUtc && (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz) || /^Etc\//i.test(tz))) return null;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return canonical === 'UTC' || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(canonical) ? canonical : null;
}

export function isValidTimeZone(tz: unknown): boolean {
  return canonicalTimeZone(tz) !== null;
}

/**
 * "Today" as the workspace sees it. MUST be computed on the server from the workspace's IANA
 * timezone — never the browser's, which a user could spoof to dodge the late-entry rule.
 */
export function todayIn(timeZone: string): CalendarDate {
  return dayjs().tz(timeZone).format('YYYY-MM-DD') as CalendarDate;
}

/** Formats a CalendarDate via UTC — never via a local Date, which would risk an off-by-one. */
export function formatCalendarDate(d: CalendarDate, pattern: string): string {
  return toUtc(d).format(pattern);
}

/** The calendar day an instant falls on in the given IANA timezone. */
export function calendarDayOf(date: Date, timeZone: string): CalendarDate {
  return dayjs(date).tz(timeZone).format('YYYY-MM-DD') as CalendarDate;
}

/**
 * Formats an instant (created_at, submitted_at, …) in the given IANA timezone, with the zone
 * abbreviation appended (e.g. "Oct 21, 2026 4:05 PM EDT") — legal-record timestamps must be
 * unambiguous about which timezone they're in.
 */
export function formatInstant(date: Date, timeZone: string, pattern: string): string {
  const zoned = dayjs(date).tz(timeZone);
  const abbreviation = zoned.offsetName('short');
  return abbreviation ? `${zoned.format(pattern)} ${abbreviation}` : zoned.format(pattern);
}
