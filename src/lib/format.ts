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

// ── Numbers (feature-plan-ux-kit-contracts.md §3.3). Tabular figures are global (globals.css). ──────────────────────

const CURRENCY_CENTS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CURRENCY_WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const HOURS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** A number, or a database decimal string; null for nothing usable. */
function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "$1,234.50", or whole dollars "$1,235" with `{ cents: false }`; "—" for null, '' or NaN. */
export function formatCurrency(v: number | string | null | undefined, opts: { cents?: boolean } = {}): string {
  const n = toNumber(v);
  if (n === null) return '—';
  return (opts.cents === false ? CURRENCY_WHOLE : CURRENCY_CENTS).format(n);
}

/** Hours with two decimals, "1,719.00"; '' for 0 with `{ blankZero: true }`; "—" for null, '' or NaN. */
export function formatHours(v: number | string | null | undefined, opts: { blankZero?: boolean } = {}): string {
  const n = toNumber(v);
  if (n === null) return '—';
  if (opts.blankZero && n === 0) return '';
  return HOURS.format(n);
}

/** A whole count with separators, "1,234". */
export function formatCount(n: number): string {
  return COUNT.format(n);
}
