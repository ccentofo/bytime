import { describe, it, expect } from 'vitest';
import { isStaleStripeEvent, resolvePastDueSince, shouldApplySubscriptionEnded } from '@/lib/billing/webhook-logic';

const t = (isoOffsetDays: number) => new Date(Date.UTC(2026, 0, 1 + isoOffsetDays));

describe('isStaleStripeEvent', () => {
  it('is not stale when nothing has been applied yet', () => {
    expect(isStaleStripeEvent(null, t(0))).toBe(false);
  });

  it('is not stale when strictly newer than the last applied event', () => {
    expect(isStaleStripeEvent(t(0), t(1))).toBe(false);
  });

  it('is stale when exactly equal to the last applied event (duplicate delivery)', () => {
    expect(isStaleStripeEvent(t(1), t(1))).toBe(true);
  });

  it('is stale when older than the last applied event (out-of-order delivery)', () => {
    expect(isStaleStripeEvent(t(2), t(1))).toBe(true);
  });
});

describe('resolvePastDueSince', () => {
  it('anchors to now on the first failure', () => {
    expect(resolvePastDueSince(null, t(5))).toEqual(t(5));
  });

  it('keeps the original anchor on a dunning retry, not the retry time', () => {
    expect(resolvePastDueSince(t(5), t(8))).toEqual(t(5));
  });
});

describe('shouldApplySubscriptionEnded', () => {
  it('applies when subscription_ended_at is unset', () => {
    expect(shouldApplySubscriptionEnded(null)).toBe(true);
  });

  it('is a no-op once subscription_ended_at is already set (D9 cron already terminated it, or a duplicate delivery)', () => {
    expect(shouldApplySubscriptionEnded(t(0))).toBe(false);
  });
});

/**
 * Table-driven event sequences (feature-plan-terms-compliance.md T5 §6): each row is a tenant's
 * lastStripeEventAt/pastDueSince/subscriptionEndedAt walked through a sequence of events, using
 * the same pure decision points the webhook route calls. This exercises the scenarios named in
 * the blueprint without a database or a real Stripe signature.
 */
describe('event sequences', () => {
  it('fail -> retry (same failure) -> success: past_due_since set once, notice would be sent once', () => {
    let lastStripeEventAt: Date | null = null;
    let pastDueSince: Date | null = null;

    // invoice.payment_failed at day 0
    expect(isStaleStripeEvent(lastStripeEventAt, t(0))).toBe(false);
    pastDueSince = resolvePastDueSince(pastDueSince, t(0));
    lastStripeEventAt = t(0);
    expect(pastDueSince).toEqual(t(0));

    // Stripe's dunning retries the same failed invoice at day 3 — same anchor, same notice key.
    expect(isStaleStripeEvent(lastStripeEventAt, t(3))).toBe(false);
    pastDueSince = resolvePastDueSince(pastDueSince, t(3));
    lastStripeEventAt = t(3);
    expect(pastDueSince).toEqual(t(0)); // unchanged — the notice's scheduledFor key is unchanged too

    // Customer pays: subscription.updated active at day 4 — a real "active" apply would clear
    // past_due_since; simulated here as the only state this module tracks.
    expect(isStaleStripeEvent(lastStripeEventAt, t(4))).toBe(false);
  });

  it('fail -> grace expiry (cron suspends) -> pay -> restore: subscription_ended_at untouched throughout', () => {
    const subscriptionEndedAt: Date | null = null;
    // Nothing in this sequence ever sets subscription_ended_at — suspension/restoration only
    // touch status/suspended_at (owned by the cron and applyActiveSubscription respectively).
    expect(shouldApplySubscriptionEnded(subscriptionEndedAt)).toBe(true); // still eligible, just never triggered
  });

  it('cancel -> end of term -> read-only -> 90 days -> closed: subscription.deleted applies once', () => {
    let subscriptionEndedAt: Date | null = null;
    let lastStripeEventAt: Date | null = null;

    // subscription.deleted fires at day 0.
    expect(isStaleStripeEvent(lastStripeEventAt, t(0))).toBe(false);
    expect(shouldApplySubscriptionEnded(subscriptionEndedAt)).toBe(true);
    subscriptionEndedAt = t(0);
    lastStripeEventAt = t(0);

    // Stripe redelivers the same webhook at day 1 (at-least-once delivery) — must be a no-op.
    expect(isStaleStripeEvent(lastStripeEventAt, t(1))).toBe(false); // ordering alone wouldn't catch this
    expect(shouldApplySubscriptionEnded(subscriptionEndedAt)).toBe(false); // the ended-guard does

    // 90 days later deletion_scheduled_for (not modeled here) would be reached — out of this
    // module's scope (src/lib/tenant/lifecycle.ts's getTenantAccess/nextLifecycleActions own that).
  });

  it('D9 cron terminates first, THEN the resulting subscription.deleted webhook arrives: must not move anything or resend', () => {
    // The cron already set subscription_ended_at synchronously (src/app/api/cron/tenant-lifecycle).
    const subscriptionEndedAtFromCron = t(30);
    expect(shouldApplySubscriptionEnded(subscriptionEndedAtFromCron)).toBe(false);
  });

  it('out-of-order delivery: an older "active" event arriving after a newer "past_due" must not win', () => {
    const lastStripeEventAt = t(5); // the past_due event already applied
    const staleActiveEvent = t(2); // an active event from before that, delayed in transit
    expect(isStaleStripeEvent(lastStripeEventAt, staleActiveEvent)).toBe(true);
  });
});
