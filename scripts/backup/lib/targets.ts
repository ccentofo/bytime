/**
 * Restore-test target choice (feature-plan-database-backups.md §6.7 step 5, U7).
 *
 * - Eligible workspaces (E): active, suspended or provisioning with a URL, and an `ok` backup in the last 36 h.
 * - Due date: the `tested_at` of the latest PASS, or, if it never passed, the first `ok` backup's `finished_at`.
 * - N = max(1, ceil(E / 12), number of eligible workspaces due more than 11 weeks ago). E = 0 → control plane only.
 * - The N oldest due dates, ties broken at random, tested in due-date order (a deadline cut drops the newest).
 *
 * A 12-week cycle with "overdue" at 11 weeks leaves a week of slack inside BUSINESS-DECISIONS §5's 13-week rule.
 */

export const WEEK_MS = 7 * 24 * 3600_000;
export const CYCLE_WEEKS = 12;
export const OVERDUE_WEEKS = 11;

export interface EligibleWorkspace {
  tenantId: string;
  slug: string;
  dueAt: Date;
}

export function targetCount(eligible: number, overdue: number): number {
  if (eligible === 0) return 0;
  return Math.min(eligible, Math.max(1, Math.ceil(eligible / CYCLE_WEEKS), overdue));
}

export function chooseTargets(eligible: EligibleWorkspace[], now: Date, random: () => number = Math.random): EligibleWorkspace[] {
  const overdueBefore = now.getTime() - OVERDUE_WEEKS * WEEK_MS;
  const overdue = eligible.filter((e) => e.dueAt.getTime() < overdueBefore).length;
  const n = targetCount(eligible.length, overdue);
  const shuffled = eligible.map((e) => ({ e, r: random() }));
  shuffled.sort((a, b) => a.e.dueAt.getTime() - b.e.dueAt.getTime() || a.r - b.r);
  return shuffled.slice(0, n).map((x) => x.e);
}
