import { formatCalendarDate, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { periodLabel } from '@/lib/timesheet/labels';

/**
 * The Unpriced hours report's filters from a URL (feature-plan-ux-kit-contracts.md §4.4.2), shared by the page, its
 * Excel route and the actions. `start`/`end` and the legacy `startDate`/`endDate` are both accepted (old links keep
 * working); ids must be UUIDs and dates real calendar dates — anything else is ignored, never an error. With no dates
 * the report is All time, so a scoped link from Contracts matches its cell.
 */
export interface UnpricedFilterInput {
  contractId?: string;
  clinId?: string;
  slinId?: string;
  startDate?: string;
  endDate?: string;
  reason?: 'conflict';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Raw = Record<string, string | string[] | undefined | null>;
const first = (v: string | string[] | undefined | null) => (Array.isArray(v) ? v[0] : v) ?? undefined;

export function parseUnpricedFilters(raw: Raw): UnpricedFilterInput {
  const id = (k: string) => { const v = first(raw[k]); return v && UUID.test(v) ? v : undefined; };
  const date = (...keys: string[]) => { for (const k of keys) { const v = first(raw[k]); if (v && isCalendarDate(v)) return v; } return undefined; };
  const out: UnpricedFilterInput = {};
  const contractId = id('contractId'); if (contractId) out.contractId = contractId;
  const clinId = id('clinId'); if (clinId) out.clinId = clinId;
  const slinId = id('slinId'); if (slinId) out.slinId = slinId;
  const startDate = date('start', 'startDate'); if (startDate) out.startDate = startDate;
  const endDate = date('end', 'endDate'); if (endDate) out.endDate = endDate;
  if (first(raw.reason) === 'conflict') out.reason = 'conflict';
  return out;
}

/** The same filters back as a query string (`start`/`end`), for links and the Excel download. */
export function unpricedFiltersQuery(f: UnpricedFilterInput): string {
  const p = new URLSearchParams();
  if (f.contractId) p.set('contractId', f.contractId);
  if (f.clinId) p.set('clinId', f.clinId);
  if (f.slinId) p.set('slinId', f.slinId);
  if (f.startDate) p.set('start', f.startDate);
  if (f.endDate) p.set('end', f.endDate);
  if (f.reason) p.set('reason', f.reason);
  return p.toString();
}

/**
 * The keys a download link may carry, each checked on its own (UX-4B1-AUDIT L8): a present value must be valid, but a
 * legacy key next to its preferred one (`startDate` beside `start`) is allowed — `start`/`end` win in the parser.
 */
export const UNPRICED_FILTER_KEYS = ['contractId', 'clinId', 'slinId', 'start', 'end', 'startDate', 'endDate', 'reason'] as const;

export function invalidUnpricedFilterKeys(raw: Record<string, string | undefined | null>): string[] {
  return UNPRICED_FILTER_KEYS.filter((k) => {
    const v = raw[k];
    if (v === undefined || v === null || v === '') return false;
    if (k === 'reason') return v !== 'conflict';
    if (k.endsWith('Id')) return !UUID.test(v);
    return !isCalendarDate(v);
  });
}

/** "CLIN 0001" / "CLIN 0001 · SLIN 0001AA", or null with no CLIN (the Unpriced page's scope chip, M2). */
export function lineScopeLabel(names: { clinNumber: string | null; slinNumber: string | null }): string | null {
  if (!names.clinNumber) return null;
  return `CLIN ${names.clinNumber}${names.slinNumber ? ` · SLIN ${names.slinNumber}` : ''}`;
}

/**
 * The Excel's scope line (L8): the range — both ends, "From …", "Through …" or All time —, then the contract and the
 * CLIN / SLIN, then "overlapping categories only" for reason=conflict. E.g. "From Oct 1, 2026 · Army (W1) · CLIN 0001".
 */
export function unpricedScopeLabel(f: UnpricedFilterInput, names: { contract: string | null; clinNumber: string | null; slinNumber: string | null }): string {
  const day = (d: string) => formatCalendarDate(d as CalendarDate, 'MMM D, YYYY');
  const range = f.startDate && f.endDate ? periodLabel(f.startDate as CalendarDate, f.endDate as CalendarDate)
    : f.startDate ? `From ${day(f.startDate)}`
      : f.endDate ? `Through ${day(f.endDate)}`
        : 'All time';
  return [range, names.contract, lineScopeLabel(names), f.reason ? 'overlapping categories only' : null].filter(Boolean).join(' · ');
}
