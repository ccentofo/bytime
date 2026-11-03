/**
 * Cost-view labels (feature-plan-certified-outputs.md C3). Client-safe.
 * - CO-D7 (feature-plan-dated-rates.md D2): every cost view says each hour is priced at the rate in effect that day.
 * - CO-D17: totals never quietly shrink — every cost / funding-used total carries "X hours unpriced" while X > 0, and a
 *   funding figure is labelled "priced cost".
 */
export const CURRENT_RATES_NOTE = 'Costs use the labor-category rate in effect on each day worked.';
export const UNPRICED_REPORT_HREF = '/admin/labor-categories?report=unpriced';

/**
 * The Unpriced hours report scoped to a contract / CLIN / SLIN (feature-plan-ux-kit-contracts.md §4.1, §4.4.9): built
 * with URLSearchParams, so it's always `?a=…&b=…` (never a second `?`).
 */
export function unpricedReportHref(scope: { contractId?: string; clinId?: string; slinId?: string; reason?: string } = {}): string {
  const [path, query = ''] = UNPRICED_REPORT_HREF.split('?');
  const params = new URLSearchParams(query);
  for (const [k, v] of Object.entries(scope)) if (v) params.set(k, v);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

export function unpricedHoursLabel(hours: number): string | null {
  if (!(hours > 0)) return null;
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'} unpriced`;
}
