export type PlanKey = 'trial' | 'starter' | 'pro' | 'enterprise';

export const PLANS: Record<PlanKey, { label: string; priceId: string | null; seatLimit: number | null }> = {
  trial:      { label: 'Trial',      priceId: null,                                     seatLimit: 10 },
  starter:    { label: 'Starter',    priceId: process.env.STRIPE_PRICE_STARTER ?? '',   seatLimit: 25 },
  pro:        { label: 'Pro',        priceId: process.env.STRIPE_PRICE_PRO ?? '',        seatLimit: 100 },
  enterprise: { label: 'Enterprise', priceId: process.env.STRIPE_PRICE_ENTERPRISE ?? '', seatLimit: null },
};

/** Map a Stripe price ID back to a plan key (for webhook → plan sync). */
export function planForPriceId(priceId: string | null | undefined): PlanKey {
  if (!priceId) return 'trial';
  const entry = (Object.entries(PLANS) as [PlanKey, typeof PLANS[PlanKey]][])
    .find(([, p]) => p.priceId && p.priceId === priceId);
  return entry?.[0] ?? 'trial';
}
