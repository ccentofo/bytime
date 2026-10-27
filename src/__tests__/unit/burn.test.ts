import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { BURN_TIER_LABEL, burnPercent, burnTier, remainingWarning } from '@/lib/ui/burn';

/**
 * feature-plan-ux-navigation-home.md §4.5.3 / T11 (UX2-Q2 default): one burn rule for the Dashboard and Home — the
 * percent is rounded BEFORE tiering; no funded value is "No funding set", never "Over funding".
 */

const tier = (cost: number, funded: number | null) => burnTier(burnPercent(cost, funded), funded, (funded ?? 0) - cost);

describe('burn tiers (T11)', () => {
  it('rounding first: 74.6 → 75 → Watch; 74.4 → 74 → On track; 89.5 → 90 → Near limit', () => {
    expect(burnPercent(746, 1000)).toBe(75);
    expect(tier(746, 1000)).toBe('watch');
    expect(burnPercent(744, 1000)).toBe(74);
    expect(tier(744, 1000)).toBe('onTrack');
    expect(burnPercent(895, 1000)).toBe(90);
    expect(tier(895, 1000)).toBe('nearLimit');
  });

  it('remaining < 0 → Over funding; funded null or 0 → No funding set (never Over funding)', () => {
    expect(tier(1200, 1000)).toBe('overFunding');
    expect(tier(500, null)).toBe('noFunding');
    expect(tier(500, 0)).toBe('noFunding');
    expect(burnPercent(500, 0)).toBe(0);
    expect(burnPercent(500, null)).toBe(0);
    expect(BURN_TIER_LABEL).toEqual({ noFunding: 'No funding set', overFunding: 'Over funding', nearLimit: 'Near limit', watch: 'Watch', onTrack: 'On track' });
  });

  it('remainingWarning: 9,999 warns, 10,000 does not; negative is not a "running low" warning (it is Over funding)', () => {
    expect(remainingWarning(9999)).toBe(true);
    expect(remainingWarning(0)).toBe(true);
    expect(remainingWarning(10000)).toBe(false);
    expect(remainingWarning(-1)).toBe(false);
  });

  it('static: DashboardClient uses the shared tiers (no private burn colours)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/(app)/admin/dashboard/DashboardClient.tsx'), 'utf8');
    expect(src).toContain("from '@/lib/ui/burn'");
    expect(src).toMatch(/burnTier\(/);
    expect(src).toMatch(/burnPercent\(/);
    expect(src).not.toMatch(/function getBurnColor/);
    expect(src).not.toMatch(/remaining < 10000/);
  });
});
