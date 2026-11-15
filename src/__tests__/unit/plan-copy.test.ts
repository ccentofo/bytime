import { describe, it, expect } from 'vitest';
import * as copy from '@/lib/billing/plan-copy';
import { TRIAL_DAYS } from '@/lib/tenant/lifecycle-config';

/**
 * U1 (feature-plan-per-user-billing.md §6.1): the customer-facing plan strings are BUSINESS-DECISIONS.md §1, byte for
 * byte (written out here: the business file isn't committed); STANDARD_USERS_LINE is the product owner's Q7 string.
 */
describe('U1: plan-copy', () => {
  it('the eight §1 price strings', () => {
    expect(copy.PRICE_COPY).toEqual({
      trial: { price: 'Free for 30 days', detail: 'Up to 10 users. No credit card required.' },
      standardMonthly: { price: '$10 / user / month', detail: '$50 minimum (covers up to 5 users)' },
      standardAnnual: { price: '$8.50 / user / month, billed annually', detail: '$510 minimum per year (covers up to 5 users)' },
      enterprise: { price: 'Contact us', detail: 'More than 100 users, invoicing, or custom terms' },
    });
  });

  it('the §1 mailto and the §1 cap message', () => {
    expect(copy.ENTERPRISE_MAILTO).toBe('mailto:support@cadenzpoint.com?subject=CadenzPoint%20Enterprise');
    expect(copy.STANDARD_CAP_MESSAGE).toBe('Your plan covers up to 100 users. Contact us at support@cadenzpoint.com to add more.');
  });

  it('the Q7 users line, the limits and the flat tier', () => {
    expect(copy.STANDARD_USERS_LINE).toBe('Up to 100 users');
    expect(copy.PLAN_SEAT_LIMIT).toEqual({ trial: 10, standard: 100, enterprise: null });
    expect(copy.STANDARD_FLAT_TIER_USERS).toBe(5);
  });

  it('"Free for 30 days" matches the trial length', () => {
    expect(TRIAL_DAYS).toBe(30);
  });
});
