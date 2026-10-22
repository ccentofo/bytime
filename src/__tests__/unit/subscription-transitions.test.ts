import { describe, it, expect } from 'vitest';
import { selectTracked, computeSubscriptionTransition, type StripeSubSnapshot } from '@/lib/billing/subscription-transitions';
import { addDays, type LifecycleFacts } from '@/lib/tenant/lifecycle';

// feature-plan-terms-compliance-fixes.md §4.3 / §7 webhook matrix: subscription selection and every row of the
// transition table, computed from Stripe's CURRENT state (never event order).

const NOW = new Date('2026-06-15T12:00:00Z');
const d = (days: number) => addDays(NOW, days);

function sub(id: string, status: string, o: Partial<StripeSubSnapshot> = {}): StripeSubSnapshot {
  return { id, status, created: d(-30), endedAt: null, currentPeriodEnd: d(15), plan: 'starter', ...o };
}
function facts(o: Partial<LifecycleFacts> = {}): LifecycleFacts {
  return {
    status: 'active', subscriptionStatus: null, stripeSubscriptionId: null, trialEndsAt: d(-200),
    pastDueSince: null, suspendedAt: null, suspensionReason: null, subscriptionEndedAt: null,
    deletionScheduledFor: null, firstGoodAt: null, lifecycleExempt: false, policyExportAllowed: false, ...o,
  };
}
const transition = (f: LifecycleFacts, subs: StripeSubSnapshot[], trackedId: string | null = f.stripeSubscriptionId) => {
  const { tracked, duplicateLive } = selectTracked(subs, trackedId);
  return computeSubscriptionTransition(f, tracked, subs, duplicateLive, NOW);
};

describe('selectTracked (§4.3 rule 4)', () => {
  it('keeps the tracked subscription when it is GOOD', () => {
    expect(selectTracked([sub('a', 'active'), sub('b', 'active', { created: d(-1) })], 'a').tracked?.id).toBe('a');
  });
  it('prefers a GOOD duplicate over a DUNNING tracked subscription (never ignore a paying one)', () => {
    expect(selectTracked([sub('a', 'past_due'), sub('b', 'active')], 'a').tracked?.id).toBe('b');
  });
  it('adopts a new live subscription when the tracked one is canceled (S2 active before S1 deleted)', () => {
    expect(selectTracked([sub('s1', 'canceled'), sub('s2', 'active', { created: d(-1) })], 's1').tracked?.id).toBe('s2');
  });
  it('falls back to the newest incomplete when nothing is live', () => {
    expect(selectTracked([sub('old', 'canceled'), sub('new', 'incomplete', { created: d(-1) })], null).tracked?.id).toBe('new');
  });
  it('flags duplicate live subscriptions', () => {
    expect(selectTracked([sub('a', 'active'), sub('b', 'past_due')], 'a').duplicateLive).toBe(true);
  });
  it('no subscriptions → nothing tracked', () => {
    expect(selectTracked([], null).tracked).toBeNull();
  });
});

describe('computeSubscriptionTransition (§4.3 table)', () => {
  it('GOOD restores full: clears grace, suspension (nonpayment), end and deletion; sets first_good_at', () => {
    const f = facts({ subscriptionStatus: 'unpaid', stripeSubscriptionId: 's', pastDueSince: d(-20), status: 'suspended', suspendedAt: d(-5), suspensionReason: 'nonpayment', firstGoodAt: d(-100) });
    const r = transition(f, [sub('s', 'active')]);
    expect(r.patch).toMatchObject({ subscriptionStatus: 'active', pastDueSince: null, suspendedAt: null, suspensionReason: null, status: 'active', subscriptionEndedAt: null, deletionScheduledFor: null });
    expect(r.patch.firstGoodAt?.getTime()).toBe(d(-100).getTime());
  });
  it('a policy suspension survives invoice.paid (GOOD does not lift it)', () => {
    const f = facts({ subscriptionStatus: 'active', stripeSubscriptionId: 's', status: 'suspended', suspensionReason: 'policy', suspendedAt: d(-2), firstGoodAt: d(-100) });
    const r = transition(f, [sub('s', 'active')]);
    expect(r.patch.status).toBeUndefined();
    expect(r.patch.suspensionReason).toBeUndefined();
  });
  it('first GOOD sets first_good_at = now (conversion)', () => {
    const r = transition(facts(), [sub('s', 'active')], null);
    expect(r.patch.firstGoodAt?.getTime()).toBe(NOW.getTime());
    expect(r.patch.stripeSubscriptionId).toBe('s');
  });
  it('DUNNING starts grace once: past_due_since set, payment-failed notice anchored on it', () => {
    const r = transition(facts({ subscriptionStatus: 'active', stripeSubscriptionId: 's', firstGoodAt: d(-60) }), [sub('s', 'past_due')]);
    expect(r.patch.pastDueSince?.getTime()).toBe(NOW.getTime());
    expect(r.notices).toEqual([{ kind: 'payment-failed', anchor: NOW }]);
  });
  it('DUNNING keeps the original past_due_since (retries don\'t restart the clock or resend)', () => {
    const P = d(-4);
    const r = transition(facts({ subscriptionStatus: 'past_due', stripeSubscriptionId: 's', pastDueSince: P, firstGoodAt: d(-60) }), [sub('s', 'past_due')]);
    expect(r.patch.pastDueSince?.getTime()).toBe(P.getTime());
    expect(r.notices[0].anchor.getTime()).toBe(P.getTime());
  });
  it('DUNNING first seen sets first_good_at (so a later cancel gets the export window)', () => {
    const r = transition(facts(), [sub('s', 'past_due')], null);
    expect(r.patch.firstGoodAt?.getTime()).toBe(NOW.getTime());
  });
  it('DUNNING after termination only mirrors the status (no grace restart, no notice)', () => {
    const f = facts({ subscriptionStatus: 'canceled', stripeSubscriptionId: 's', subscriptionEndedAt: d(-2), deletionScheduledFor: d(88), firstGoodAt: d(-100) });
    const r = transition(f, [sub('s', 'past_due')]);
    expect(r.patch.pastDueSince).toBeUndefined();
    expect(r.notices).toEqual([]);
  });
  it('canceled after paying → ended at Stripe\'s ended_at, D = E + 90d, read_only path, notice', () => {
    const E = d(-1);
    const f = facts({ subscriptionStatus: 'active', stripeSubscriptionId: 's', firstGoodAt: d(-100) });
    const r = transition(f, [sub('s', 'canceled', { endedAt: E })]);
    expect(r.patch.subscriptionEndedAt?.getTime()).toBe(E.getTime());
    expect(r.patch.deletionScheduledFor?.getTime()).toBe(addDays(E, 90).getTime());
    expect(r.notices).toEqual([{ kind: 'subscription-ended', anchor: E }]);
  });
  it('a duplicate subscription.deleted after our own termination is a no-op (E and D never move)', () => {
    const f = facts({ subscriptionStatus: 'canceled', stripeSubscriptionId: 's', subscriptionEndedAt: d(-3), deletionScheduledFor: d(87), firstGoodAt: d(-100) });
    const r = transition(f, [sub('s', 'canceled', { endedAt: d(-2) })]);
    expect(r.patch.subscriptionEndedAt).toBeUndefined();
    expect(r.patch.deletionScheduledFor).toBeUndefined();
    expect(r.notices).toEqual([]);
  });
  it('canceled never-GOOD during a trial → status only (trial rules continue)', () => {
    const r = transition(facts({ trialEndsAt: d(5) }), [sub('s', 'canceled', { endedAt: d(-1) })], null);
    expect(r.patch.subscriptionEndedAt).toBeUndefined();
    expect(r.notices).toEqual([]);
  });
  it('lost subscription.deleted + new incomplete checkout still records the old cancellation', () => {
    const f = facts({ subscriptionStatus: 'active', stripeSubscriptionId: 'old', firstGoodAt: d(-100) });
    const r = transition(f, [sub('old', 'canceled', { endedAt: d(-10) }), sub('new', 'incomplete', { created: d(-1) })]);
    expect(r.patch.subscriptionEndedAt?.getTime()).toBe(d(-10).getTime());
    expect(r.patch.stripeSubscriptionId).toBe('new');
    expect(r.patch.subscriptionStatus).toBe('incomplete'); // still visible to the reconcile trigger
  });
  it('an exempt workspace that ends is never scheduled for deletion and gets no lifecycle email (F1)', () => {
    const f = facts({ subscriptionStatus: 'active', stripeSubscriptionId: 's', firstGoodAt: d(-100), lifecycleExempt: true });
    const r = transition(f, [sub('s', 'canceled', { endedAt: d(-1) })]);
    expect(r.patch.subscriptionEndedAt).toBeTruthy();
    expect(r.patch.deletionScheduledFor).toBeUndefined();
    expect(r.notices).toEqual([]);
  });
  it('paid-before with NO subscriptions left (retrieve also missing) → ended at now + alert, never stuck', () => {
    const f = facts({ subscriptionStatus: 'active', stripeSubscriptionId: 'gone', firstGoodAt: d(-100) });
    const r = transition(f, []);
    expect(r.patch.subscriptionEndedAt?.getTime()).toBe(NOW.getTime());
    expect(r.patch.deletionScheduledFor?.getTime()).toBe(addDays(NOW, 90).getTime());
    expect(r.alerts.map((a) => a.kind)).toContain('cancellation-time-unknown');
    expect(r.notices).toEqual([{ kind: 'subscription-ended', anchor: NOW }]);
  });
  it('never-subscribed tenant with a bare customer and no subscriptions → no change', () => {
    const r = transition(facts({ trialEndsAt: d(5) }), [], null);
    expect(r.patch).toEqual({});
    expect(r.notices).toEqual([]);
  });
  it('a canceled policy-suspended tenant stays suspended, gets no export-window email, and alerts', () => {
    const f = facts({ subscriptionStatus: 'active', stripeSubscriptionId: 's', firstGoodAt: d(-100), status: 'suspended', suspensionReason: 'policy', suspendedAt: d(-3) });
    const r = transition(f, [sub('s', 'canceled', { endedAt: d(-1) })]);
    expect(r.patch.status).toBeUndefined();
    expect(r.notices).toEqual([]);
    expect(r.alerts.map((a) => a.kind)).toContain('policy-suspended-subscription-ended');
  });
  it('paused → status only + alert', () => {
    const r = transition(facts({ firstGoodAt: d(-100), stripeSubscriptionId: 's' }), [sub('s', 'paused')]);
    expect(r.alerts.map((a) => a.kind)).toContain('paused-subscription');
    expect(r.patch.pastDueSince).toBeUndefined();
  });
  it('two live subscriptions → duplicate alert', () => {
    const r = transition(facts(), [sub('a', 'active'), sub('b', 'active', { created: d(-1) })], 'a');
    expect(r.alerts.map((a) => a.kind)).toContain('duplicate-live-subscriptions');
  });
  it('cancel_at_period_end (status still active) stays full until it actually ends', () => {
    const r = transition(facts({ subscriptionStatus: 'active', stripeSubscriptionId: 's', firstGoodAt: d(-100) }), [sub('s', 'active')]);
    expect(r.patch.subscriptionEndedAt).toBeNull();
  });
});
