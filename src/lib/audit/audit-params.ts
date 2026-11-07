import { REASON_CODES } from '@/lib/reason-codes';
import { addDays, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';

/**
 * The Audit trail's URL (feature-plan-ux-people-codes.md §6.1), parsed the same way by the page (first paint) and the
 * client: `range=last30|last|this|custom&start&end&user&contract&clin&reason&changed=1&tab=entries|events|admin&page`.
 * Invalid values fall back to the defaults (last30, entries, page 1); a supervisor's `tab=admin` → entries. Client-safe.
 */

export const AUDIT_TABS = ['entries', 'events', 'admin'] as const;
export type AuditTab = (typeof AUDIT_TABS)[number];
export const AUDIT_RANGES = ['last30', 'last', 'this', 'custom'] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number];
/** The reasons the filter offers: the ones users pick, plus imported rows. */
export const AUDIT_REASONS = [...REASON_CODES.map((r) => r.value), 'MIGRATION'];

export interface AuditParams {
  range: AuditRange;
  /** Custom range only (the presets resolve to dates). */
  start: CalendarDate | null;
  end: CalendarDate | null;
  user: string | null;
  contract: string | null;
  clin: string | null;
  reason: string | null;
  changed: boolean;
  tab: AuditTab;
  page: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);

export function parseAuditParams(get: (key: string) => string | null | undefined, opts: { isAdmin: boolean }): AuditParams {
  const range = (AUDIT_RANGES as readonly string[]).includes(get('range') ?? '') ? (get('range') as AuditRange) : 'last30';
  const tabRaw = (AUDIT_TABS as readonly string[]).includes(get('tab') ?? '') ? (get('tab') as AuditTab) : 'entries';
  const page = Number(get('page'));
  const contract = uuidOrNull(get('contract'));
  const start = get('start'), end = get('end');
  return {
    range,
    start: range === 'custom' && isCalendarDate(start) ? start : null,
    end: range === 'custom' && isCalendarDate(end) ? end : null,
    user: uuidOrNull(get('user')),
    contract,
    clin: contract ? uuidOrNull(get('clin')) : null,
    reason: AUDIT_REASONS.includes(get('reason') ?? '') ? get('reason')! : null,
    changed: get('changed') === '1',
    tab: tabRaw === 'admin' && !opts.isAdmin ? 'entries' : tabRaw,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The query string for the params (defaults left out). */
export function auditSearch(p: AuditParams): string {
  const q = new URLSearchParams();
  if (p.range !== 'last30') q.set('range', p.range);
  if (p.range === 'custom') { if (p.start) q.set('start', p.start); if (p.end) q.set('end', p.end); }
  if (p.user) q.set('user', p.user);
  if (p.contract) q.set('contract', p.contract);
  if (p.clin) q.set('clin', p.clin);
  if (p.reason) q.set('reason', p.reason);
  if (p.changed) q.set('changed', '1');
  if (p.tab !== 'entries') q.set('tab', p.tab);
  if (p.page > 1) q.set('page', String(p.page));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** "Last 30 days": the workspace's today and the 29 days before it. */
export function last30Days(today: CalendarDate): { start: CalendarDate; end: CalendarDate } {
  return { start: addDays(today, -29), end: today };
}

/** The CSV link for the entry filters and a resolved range (§6.5). */
export function auditCsvHref(p: AuditParams, start: CalendarDate, end: CalendarDate): string {
  const q = new URLSearchParams({ start, end });
  if (p.user) q.set('user', p.user);
  if (p.contract) q.set('contract', p.contract);
  if (p.clin) q.set('clin', p.clin);
  if (p.reason) q.set('reason', p.reason);
  if (p.changed) q.set('changed', '1');
  return `/api/reports/audit-csv?${q.toString()}`;
}
