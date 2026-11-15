import 'server-only';
import { PLAN_SEAT_LIMIT } from './plan-copy';

/**
 * The per-user plan model (feature-plan-per-user-billing.md §6.1). Server-only: it reads the Standard price ids from
 * the environment, which must never reach a client bundle (client components use `plan-copy.ts`).
 */
export type PlanKey = 'trial' | 'standard' | 'enterprise';
export type BillingInterval = 'month' | 'year';

function envPrice(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

/** The two graduated Standard prices (empty env = not configured). */
export function standardPriceIds(): { month: string | null; year: string | null } {
  return { month: envPrice('STRIPE_PRICE_STANDARD_MONTHLY'), year: envPrice('STRIPE_PRICE_STANDARD_ANNUAL') };
}

/** The interval of a Standard price, or null when the price isn't one of the two Standard prices. */
export function priceInfo(priceId: string | null | undefined): { interval: BillingInterval } | null {
  if (!priceId) return null;
  const ids = standardPriceIds();
  if (ids.month !== null && priceId === ids.month) return { interval: 'month' };
  if (ids.year !== null && priceId === ids.year) return { interval: 'year' };
  return null;
}

/**
 * Seat limit for a stored plan value. `starter`/`pro` are the legacy values, only seen in the deploy window right
 * after the migration that rewrites them to `standard`. Unknown values keep today's fallback (the trial limit).
 */
export function seatLimitFor(plan: string): number | null {
  if (plan === 'enterprise') return PLAN_SEAT_LIMIT.enterprise;
  if (plan === 'standard' || plan === 'starter' || plan === 'pro') return PLAN_SEAT_LIMIT.standard;
  return PLAN_SEAT_LIMIT.trial;
}

/** The plan as the UI shows it. */
export function displayPlan(plan: string): PlanKey {
  if (plan === 'enterprise') return 'enterprise';
  if (plan === 'standard' || plan === 'starter' || plan === 'pro') return 'standard';
  return 'trial';
}

/** The minimal subscription-item shape this module reads (tolerates any Stripe payload shape). */
export interface SubscriptionItemLike {
  id?: string;
  quantity?: number | null;
  price?: { id?: string | null } | null;
}

/** The Standard item of a subscription: the first item on one of the two Standard prices, or null. */
export function standardItemOf<T extends SubscriptionItemLike>(items: readonly T[] | null | undefined): T | null {
  for (const item of items ?? []) {
    if (priceInfo(item?.price?.id ?? null)) return item;
  }
  return null;
}

/**
 * The plan facts of a subscription (§6.2): `{ plan: 'standard', interval }` when SOME item is on a Standard price,
 * else null, which means "leave the stored plan as it is" (a custom Enterprise price, or a missing env value, must
 * never downgrade a paying customer).
 */
export function planForSubscription(items: readonly SubscriptionItemLike[] | null | undefined): { plan: 'standard'; interval: BillingInterval } | null {
  const item = standardItemOf(items);
  const info = item ? priceInfo(item.price?.id ?? null) : null;
  return info ? { plan: 'standard', interval: info.interval } : null;
}
