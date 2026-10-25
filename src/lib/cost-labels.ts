/**
 * Cost-view labels (feature-plan-certified-outputs.md C3). Client-safe.
 * - CO-D7 interim: every cost view says rates are today's.
 * - CO-D17: totals never quietly shrink — every cost / funding-used total carries "X hours unpriced" while X > 0, and a
 *   funding figure is labelled "priced cost".
 */
export const CURRENT_RATES_NOTE = 'Costs use current labor-category rates.';
export const UNPRICED_REPORT_HREF = '/admin/labor-categories?report=unpriced';

export function unpricedHoursLabel(hours: number): string | null {
  if (!(hours > 0)) return null;
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'} unpriced`;
}
