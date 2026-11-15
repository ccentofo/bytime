import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));

import { planSeatUpdates, inRenewalWindow, type PlannedCall } from '@/lib/billing/seat-sync';
import { displayPlan, planForSubscription, priceInfo, seatLimitFor, standardPriceIds } from '@/lib/billing/plans';

/** U2 (feature-plan-per-user-billing.md §7.2): every row of the quantity-plan table, for both intervals. */
describe('U2: planSeatUpdates', () => {
  const prorate = { month: 'create_prorations', year: 'always_invoice' } as const;
  const cases: Array<[string, number, number, boolean, (i: 'month' | 'year') => PlannedCall[]]> = [
    ['equal, outside the window', 8, 8, false, () => []],
    ['equal, inside the window', 8, 8, true, () => []],
    ['removal mid-term → held', 8, 6, false, () => []],
    ['removal in the window → D', 8, 6, true, () => [{ label: 'D', quantity: 6, proration: 'none' }]],
    ['removal below the flat tier, in the window → D', 4, 2, true, () => [{ label: 'D', quantity: 2, proration: 'none' }]],
    ['removal below the flat tier, mid-term → none', 4, 2, false, () => []],
    ['re-add after a mid-term removal (Stripe 8, count back to 8) → none', 8, 8, false, () => []],
    ['increase inside the flat tier → A only', 3, 5, false, () => [{ label: 'A', quantity: 5, proration: 'none' }]],
    ['increase inside the flat tier, in the window → A only', 3, 5, true, () => [{ label: 'A', quantity: 5, proration: 'none' }]],
    ['increase crossing the flat tier → A then B', 4, 7, false, (i) => [{ label: 'A', quantity: 5, proration: 'none' }, { label: 'B', quantity: 7, proration: prorate[i] }]],
    ['increase crossing the flat tier, in the window → A then B', 4, 7, true, (i) => [{ label: 'A', quantity: 5, proration: 'none' }, { label: 'B', quantity: 7, proration: prorate[i] }]],
    ['increase above the held level → B', 8, 10, false, (i) => [{ label: 'B', quantity: 10, proration: prorate[i] }]],
    ['count rises but stays under the held level, mid-term → none', 10, 9, false, () => []],
    ['the same, in the window → D', 10, 9, true, () => [{ label: 'D', quantity: 9, proration: 'none' }]],
    ['re-add after the drop, still in the window → B (prorated for the hours left)', 9, 10, true, (i) => [{ label: 'B', quantity: 10, proration: prorate[i] }]],
    ['after the window, before Stripe renews → none (waits for the next window)', 10, 8, false, () => []],
    ['1 → 3 (flat tier, the minimum quantity 1) → A', 1, 3, false, () => [{ label: 'A', quantity: 3, proration: 'none' }]],
    ['exactly 5 → 6 → B only (no A at the flat-tier edge)', 5, 6, false, (i) => [{ label: 'B', quantity: 6, proration: prorate[i] }]],
  ];
  for (const interval of ['month', 'year'] as const) {
    for (const [name, current, desired, window, expected] of cases) {
      it(`${interval}: ${name} (${current}, ${desired}, ${window ? 'window' : 'no window'})`, () => {
        expect(planSeatUpdates(current, desired, window, interval)).toEqual(expected(interval));
      });
    }
  }

  it('the window is the last day before renewal, ending 5 minutes early', () => {
    const end = 1_800_000_000;
    expect(inRenewalWindow(end - 86_401, end)).toBe(false);
    expect(inRenewalWindow(end - 86_400, end)).toBe(true);
    expect(inRenewalWindow(end - 12 * 3600, end)).toBe(true);
    expect(inRenewalWindow(end - 301, end)).toBe(true);
    expect(inRenewalWindow(end - 300, end)).toBe(false);   // 5 minutes before: no drop
    expect(inRenewalWindow(end - 240, end)).toBe(false);   // 4 minutes before (S4)
    expect(inRenewalWindow(end + 10, end)).toBe(false);    // past the period end, Stripe not renewed yet
  });
});

/** U3 (feature-plan-per-user-billing.md §6.1): the plan helpers. */
describe('U3: plan helpers', () => {
  it('seatLimitFor: trial 10, standard 100, enterprise null, legacy pro/starter 100, unknown 10', () => {
    expect(seatLimitFor('trial')).toBe(10);
    expect(seatLimitFor('standard')).toBe(100);
    expect(seatLimitFor('enterprise')).toBeNull();
    expect(seatLimitFor('pro')).toBe(100);
    expect(seatLimitFor('starter')).toBe(100);
    expect(seatLimitFor('mystery')).toBe(10);
    expect(seatLimitFor('')).toBe(10);
  });

  it('displayPlan for each of those values', () => {
    expect(displayPlan('trial')).toBe('trial');
    expect(displayPlan('standard')).toBe('standard');
    expect(displayPlan('enterprise')).toBe('enterprise');
    expect(displayPlan('pro')).toBe('standard');
    expect(displayPlan('starter')).toBe('standard');
    expect(displayPlan('mystery')).toBe('trial');
  });

  describe('price env', () => {
    beforeEach(() => {
      vi.stubEnv('STRIPE_PRICE_STANDARD_MONTHLY', 'price_m');
      vi.stubEnv('STRIPE_PRICE_STANDARD_ANNUAL', 'price_y');
    });
    afterEach(() => vi.unstubAllEnvs());

    it('standardPriceIds / priceInfo; empty env is null', () => {
      expect(standardPriceIds()).toEqual({ month: 'price_m', year: 'price_y' });
      expect(priceInfo('price_m')).toEqual({ interval: 'month' });
      expect(priceInfo('price_y')).toEqual({ interval: 'year' });
      expect(priceInfo('price_custom')).toBeNull();
      expect(priceInfo(null)).toBeNull();
      vi.stubEnv('STRIPE_PRICE_STANDARD_ANNUAL', '  ');
      expect(standardPriceIds().year).toBeNull();
      expect(priceInfo('')).toBeNull();
    });

    it('planForSubscription: standard when SOME item is on a Standard price (interval from that item), else null', () => {
      expect(planForSubscription([{ price: { id: 'price_y' } }])).toEqual({ plan: 'standard', interval: 'year' });
      expect(planForSubscription([{ price: { id: 'price_other' } }, { price: { id: 'price_m' } }])).toEqual({ plan: 'standard', interval: 'month' });
      expect(planForSubscription([{ price: { id: 'price_custom' } }])).toBeNull();
      expect(planForSubscription([])).toBeNull();
      expect(planForSubscription(undefined)).toBeNull();
    });
  });
});
