/**
 * Pure decision logic for the Stripe webhook (feature-plan-terms-compliance.md T5). Kept apart
 * from src/app/api/stripe/webhook/route.ts (which does the actual DB reads/writes and Stripe
 * event parsing) so the event-ordering and idempotency rules are unit-testable without a database
 * or a real Stripe signature — the same approach as src/lib/tenant/lifecycle.ts.
 */

/**
 * Ordering/idempotency: an event no newer than the last one this tenant already applied is a
 * duplicate delivery or an out-of-order retry and must be ignored outright — applying it could
 * regress state a later event already advanced (e.g. a delayed "active" arriving after a
 * newer "canceled").
 */
export function isStaleStripeEvent(lastStripeEventAt: Date | null, eventCreatedAt: Date): boolean {
  return lastStripeEventAt !== null && eventCreatedAt <= lastStripeEventAt;
}

/**
 * D7: `past_due_since` is set once, from the FIRST failed charge or unpaid invoice's due date.
 * Stripe's dunning retries the charge several times before giving up; each retry's
 * invoice.payment_failed (or a subscription.updated carrying status past_due/unpaid) must not
 * push the grace-period clock back out, so this keeps whatever was already recorded.
 */
export function resolvePastDueSince(current: Date | null, now: Date): Date {
  return current ?? now;
}

/**
 * T5/D9: a customer.subscription.deleted event is a no-op if `subscription_ended_at` is already
 * set — either an earlier delivery of this same event, or the D9 cron having already terminated
 * this subscription for non-payment first. Neither the dates nor the subscription-ended notice
 * may move or resend in that case.
 */
export function shouldApplySubscriptionEnded(currentSubscriptionEndedAt: Date | null): boolean {
  return currentSubscriptionEndedAt === null;
}
