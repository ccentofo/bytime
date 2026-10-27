/**
 * Contract burn tiers — ONE rule for the Dashboard and Home (feature-plan-ux-navigation-home.md §4.5.3, UX2-Q2
 * default: today's dashboard tiers, now shared, with words). The percent is rounded BEFORE tiering, as the dashboard
 * always did. Client-safe (no server imports).
 */

export type BurnTier = 'noFunding' | 'overFunding' | 'nearLimit' | 'watch' | 'onTrack';

export const BURN_TIER_LABEL: Record<BurnTier, string> = {
  noFunding: 'No funding set',
  overFunding: 'Over funding',
  nearLimit: 'Near limit',
  watch: 'Watch',
  onTrack: 'On track',
};

export const BURN_TIER_COLOR: Record<BurnTier, string> = {
  noFunding: 'gray',
  overFunding: 'red',
  nearLimit: 'red',
  watch: 'warning',
  onTrack: 'success',
};

/** Rounded percent of funding used; 0 when there is no (positive) funded value. */
export function burnPercent(cost: number, funded: number | null | undefined): number {
  if (funded === null || funded === undefined || !(funded > 0)) return 0;
  return Math.round((cost / funded) * 100);
}

/** The tier for a rounded percent. No funded value → noFunding (never "Over funding"). */
export function burnTier(pct: number, funded: number | null | undefined, remaining: number): BurnTier {
  if (funded === null || funded === undefined || !(funded > 0)) return 'noFunding';
  if (remaining < 0) return 'overFunding';
  if (pct >= 90) return 'nearLimit';
  if (pct >= 75) return 'watch';
  return 'onTrack';
}

/** The dashboard's "running low" money warning: 0 ≤ remaining < $10,000. */
export function remainingWarning(remaining: number): boolean {
  return remaining >= 0 && remaining < 10000;
}

/** Tiers Home flags in "Needs your attention" (Watch or above, never noFunding). */
export const NEEDS_A_LOOK: ReadonlySet<BurnTier> = new Set<BurnTier>(['watch', 'nearLimit', 'overFunding']);
