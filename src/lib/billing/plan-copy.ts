/**
 * Client-safe plan copy (feature-plan-per-user-billing.md §6.1). Pure strings: no imports, no env, so client
 * components may import it. The customer-facing strings are BUSINESS-DECISIONS.md §1, byte for byte (a unit test pins
 * them); `STANDARD_USERS_LINE` is the product owner's Q7 string.
 */
export const PLAN_SEAT_LIMIT = { trial: 10, standard: 100, enterprise: null } as const;
export const PRICE_COPY = {
  trial:           { price: 'Free for 30 days', detail: 'Up to 10 users. No credit card required.' },
  standardMonthly: { price: '$10 / user / month', detail: '$50 minimum (covers up to 5 users)' },
  standardAnnual:  { price: '$8.50 / user / month, billed annually', detail: '$510 minimum per year (covers up to 5 users)' },
  enterprise:      { price: 'Contact us', detail: 'More than 100 users, invoicing, or custom terms' },
} as const;
export const STANDARD_USERS_LINE = 'Up to 100 users';                 // §1 "Users" column (Q7)
export const ENTERPRISE_MAILTO = 'mailto:support@cadenzpoint.com?subject=CadenzPoint%20Enterprise';
export const STANDARD_CAP_MESSAGE = 'Your plan covers up to 100 users. Contact us at support@cadenzpoint.com to add more.';
/** Tier 1 of both Standard prices covers this many users for the flat amount (BUSINESS-DECISIONS.md §1). */
export const STANDARD_FLAT_TIER_USERS = 5;
