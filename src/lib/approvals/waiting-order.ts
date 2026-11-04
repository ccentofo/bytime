/**
 * The ONE waiting order (feature-plan-ux-approvals-payroll.md A3): pay period start, then submitted-at (never-stamped
 * last), then employee name (case- and accent-insensitive), then period id. Pure — the sidebar queue, the Approvals
 * list and "open next" all sort with it, so they always agree (there's no SQL ORDER BY to keep in step).
 */
export interface WaitingSortable {
  periodStart: string;
  submittedAt: Date | string | null;
  employeeName: string;
  periodId: string;
}

const time = (v: Date | string | null): number | null => (v === null ? null : new Date(v).getTime());

export function compareWaiting(a: WaitingSortable, b: WaitingSortable): number {
  if (a.periodStart !== b.periodStart) return a.periodStart < b.periodStart ? -1 : 1;
  const ta = time(a.submittedAt);
  const tb = time(b.submittedAt);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  const byName = a.employeeName.localeCompare(b.employeeName, undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return a.periodId < b.periodId ? -1 : a.periodId > b.periodId ? 1 : 0;
}
