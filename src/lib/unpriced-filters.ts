import { isCalendarDate } from '@/lib/calendar-date';

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
