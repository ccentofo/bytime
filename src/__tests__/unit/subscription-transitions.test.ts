import { describe, it, expect } from 'vitest';
import {
  selectTracked, computeSubscriptionTransition, computeInvoiceOverdueSince, isOverdue,
  type InvoiceFacts, type OverdueInvoiceFacts, type StripeSubSnapshot,
} from '@/lib/billing/subscription-transitions';
import { addDays, isNoticeSuperseded, type LifecycleFacts } from '@/lib/tenant/lifecycle';

// feature-plan-terms-compliance-fixes.md §4.3 / §7 webhook matrix: subscription selection and every row of the
// transition table, computed from Stripe's CURRENT state (never event order).

const NOW = new Date('2026-06-15T12:00:00Z');
const d = (days: number) => addDays(NOW, days);

function sub(id: string, status: string, o: Partial<StripeSubSnapshot> = {}): StripeSubSnapshot {
  return { id, status, created: d(-30), endedAt: null, currentPeriodEnd: d(15), plan: 'standard', interval: 'month', cancelAtPeriodEnd: false, collectionMethod: 'charge_automatically', ...o };
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

// ---------------------------------------------------------------------------
// feature-plan-per-user-billing.md §6.2 — U4 (invoiced dunning anchor) and U5 (GOOD reconcile facts)
// ---------------------------------------------------------------------------

const inv = (o: Partial<OverdueInvoiceFacts> = {}): OverdueInvoiceFacts => ({ subscriptionId: 'si', dueDate: d(-3), attemptCount: 0, processing: false, ...o });
const invoiced = (overdueSince: Date | null): InvoiceFacts => ({ kind: 'invoiced', overdueSince });
/** A send_invoice subscription read, with the invoice facts reconcile computed. */
const sendInvoiceTransition = (f: LifecycleFacts, status: string, facts: InvoiceFacts, o: Partial<StripeSubSnapshot> = {}) => {
  const subs = [sub('si', status, { collectionMethod: 'send_invoice', ...o })];
  const { tracked, duplicateLive } = selectTracked(subs, 'si');
  return computeSubscriptionTransition(f, tracked, subs, duplicateLive, NOW, facts);
};
const DUNNING_FIELDS = ['pastDueSince', 'suspendedAt', 'suspensionReason', 'status', 'subscriptionEndedAt', 'deletionScheduledFor'] as const;

describe('U4: isOverdue and computeInvoiceOverdueSince', () => {
  it('isOverdue: a null due date is overdue against any cutoff; a dated invoice when due on or before the cutoff', () => {
    expect(isOverdue({ dueDate: null }, d(-100))).toBe(true);
    expect(isOverdue({ dueDate: d(-1) }, NOW)).toBe(true);
    expect(isOverdue({ dueDate: NOW }, NOW)).toBe(true);
    expect(isOverdue({ dueDate: d(1) }, NOW)).toBe(false);
  });

  it('the earliest due date on or before now, for this subscription only; nothing overdue → null', () => {
    const invoices = [inv({ dueDate: d(-3) }), inv({ dueDate: d(-10) }), inv({ dueDate: d(5) }), inv({ subscriptionId: 'other', dueDate: d(-40) })];
    expect(computeInvoiceOverdueSince(invoices, 'si', null, null, NOW)?.getTime()).toBe(d(-10).getTime());
    expect(computeInvoiceOverdueSince([inv({ dueDate: d(5) })], 'si', null, null, NOW)).toBeNull();
    expect(computeInvoiceOverdueSince([], 'si', null, null, NOW)).toBeNull();
  });

  it('a null-due-date invoice counts only once failed: attempted and not settling → now; untried or processing → ignored', () => {
    expect(computeInvoiceOverdueSince([inv({ dueDate: null, attemptCount: 1 })], 'si', null, null, NOW)?.getTime()).toBe(NOW.getTime());
    expect(computeInvoiceOverdueSince([inv({ dueDate: null, attemptCount: 1, processing: true })], 'si', null, null, NOW)).toBeNull();
    expect(computeInvoiceOverdueSince([inv({ dueDate: null, attemptCount: 0 })], 'si', null, null, NOW)).toBeNull();
  });

  it('switched collection method (M1 of pass 5): an open null-due invoice with pastDueSince set → pastDueSince', () => {
    const P = d(-8);
    expect(computeInvoiceOverdueSince([inv({ dueDate: null })], 'si', P, null, NOW)?.getTime()).toBe(P.getTime());
  });

  it('ended tenant (M1 of pass 6): pastDueSince null, endedAt E, a null-due invoice → E (old debt)', () => {
    const E = d(-2);
    expect(computeInvoiceOverdueSince([inv({ dueDate: null })], 'si', null, E, NOW)?.getTime()).toBe(E.getTime());
  });
});

describe('U4: the send_invoice dunning branch', () => {
  const base = { subscriptionStatus: 'active', stripeSubscriptionId: 'si', firstGoodAt: d(-100), collectionMethod: 'send_invoice' } as const;

  it('overdue → pastDueSince = the due date and payment-failed anchored on it, even while Stripe says active', () => {
    const P2 = d(-3);
    const r = sendInvoiceTransition(facts(base), 'active', invoiced(P2));
    expect(r.patch.pastDueSince?.getTime()).toBe(P2.getTime());
    expect(r.notices).toEqual([{ kind: 'payment-failed', anchor: P2 }]);
    expect(r.patch.firstGoodAt?.getTime()).toBe(d(-100).getTime());
  });

  it('the anchor moves → updated, and the old payment-failed notice supersedes', () => {
    const oldP = d(-10);
    const newP = d(-3);
    const r = sendInvoiceTransition(facts({ ...base, pastDueSince: oldP }), 'past_due', invoiced(newP));
    expect(r.patch.pastDueSince?.getTime()).toBe(newP.getTime());
    expect(isNoticeSuperseded('payment-failed', oldP, facts({ ...base, pastDueSince: r.patch.pastDueSince! }), NOW)).toBe(true);
  });

  it('nothing overdue while suspended for non-payment → pastDueSince null and unsuspended, whatever Stripe says', () => {
    const f = facts({ ...base, subscriptionStatus: 'past_due', pastDueSince: d(-20), status: 'suspended', suspendedAt: d(-5), suspensionReason: 'nonpayment' });
    const r = sendInvoiceTransition(f, 'past_due', invoiced(null));
    expect(r.patch).toMatchObject({ pastDueSince: null, status: 'active', suspendedAt: null, suspensionReason: null });
    expect(r.notices).toEqual([]);
  });

  it('nothing overdue while policy-suspended → pastDueSince null, still suspended', () => {
    const f = facts({ ...base, pastDueSince: d(-20), status: 'suspended', suspendedAt: d(-5), suspensionReason: 'policy' });
    const r = sendInvoiceTransition(f, 'active', invoiced(null));
    expect(r.patch.pastDueSince).toBeNull();
    expect(r.patch.status).toBeUndefined();
    expect(r.patch.suspensionReason).toBeUndefined();
  });

  it('Stripe GOOD, overdue, suspended for non-payment, same anchor → stays suspended, suspendedAt unchanged (no daily unsuspend/re-suspend)', () => {
    const P = d(-20);
    const f = facts({ ...base, pastDueSince: P, status: 'suspended', suspendedAt: d(-5), suspensionReason: 'nonpayment' });
    const r = sendInvoiceTransition(f, 'active', invoiced(P));
    expect(r.patch.status).toBeUndefined();
    expect(r.patch.suspendedAt).toBeUndefined();
    expect(r.patch.suspensionReason).toBeUndefined();
    expect(r.patch.pastDueSince?.getTime()).toBe(P.getTime());
    // Pushed again with the SAME anchor: enqueueNotice dedups on (tenant, kind, anchor), so no new notice row —
    // and a superseded unsent row is revived (like the generic DUNNING branch).
    expect(r.notices).toEqual([{ kind: 'payment-failed', anchor: P }]);
  });

  it('the anchor moves LATER while suspended → unsuspended, pastDueSince = the new date, payment-failed for it', () => {
    const P1 = d(-30);
    const P2 = d(-1);
    const f = facts({ ...base, pastDueSince: P1, status: 'suspended', suspendedAt: d(-12), suspensionReason: 'nonpayment' });
    const r = sendInvoiceTransition(f, 'past_due', invoiced(P2));
    expect(r.patch).toMatchObject({ status: 'active', suspendedAt: null, suspensionReason: null });
    expect(r.patch.pastDueSince?.getTime()).toBe(P2.getTime());
    expect(r.notices).toEqual([{ kind: 'payment-failed', anchor: P2 }]);
  });

  it('the anchor moves EARLIER while suspended → keeps P1, stays suspended, no notice', () => {
    const P1 = d(-20);
    const f = facts({ ...base, pastDueSince: P1, status: 'suspended', suspendedAt: d(-5), suspensionReason: 'nonpayment' });
    const r = sendInvoiceTransition(f, 'past_due', invoiced(d(-40)));
    expect(r.patch.pastDueSince).toBeUndefined();
    expect(r.patch.status).toBeUndefined();
    expect(r.notices).toEqual([]);
  });

  it('ended and still owing the debt it was terminated for, Stripe GOOD → no revival (status only)', () => {
    const E = d(-5);
    const f = facts({ ...base, subscriptionEndedAt: E, deletionScheduledFor: d(85) });
    const r = sendInvoiceTransition(f, 'active', invoiced(d(-40)));
    expect(r.patch.subscriptionEndedAt).toBeUndefined();
    expect(r.patch.deletionScheduledFor).toBeUndefined();
    expect(r.patch.pastDueSince).toBeUndefined();
    expect(r.notices).toEqual([]);
    expect(r.patch.subscriptionStatus).toBe('active');
  });

  it('ended with a null-due invoice (anchored at E) → old debt: no revival (M1 of pass 6)', () => {
    const E = d(-5);
    const overdueSince = computeInvoiceOverdueSince([inv({ dueDate: null })], 'si', null, E, NOW);
    const r = sendInvoiceTransition(facts({ ...base, subscriptionEndedAt: E, deletionScheduledFor: d(85) }), 'active', invoiced(overdueSince));
    expect(r.patch.subscriptionEndedAt).toBeUndefined();
  });

  it('ended and nothing overdue → revived (end and deletion cleared)', () => {
    const r = sendInvoiceTransition(facts({ ...base, subscriptionEndedAt: d(-5), deletionScheduledFor: d(85) }), 'active', invoiced(null));
    expect(r.patch).toMatchObject({ subscriptionEndedAt: null, deletionScheduledFor: null, pastDueSince: null });
  });

  it('ended at E, a new invoiced subscription with a debt due AFTER E → revived and its grace starts', () => {
    const E = d(-20);
    const P2 = d(-2);
    const r = sendInvoiceTransition(facts({ ...base, subscriptionEndedAt: E, deletionScheduledFor: d(70) }), 'past_due', invoiced(P2));
    expect(r.patch.subscriptionEndedAt).toBeNull();
    expect(r.patch.pastDueSince?.getTime()).toBe(P2.getTime());
    expect(r.notices).toEqual([{ kind: 'payment-failed', anchor: P2 }]);
  });

  it('a debt due ON E counts as old debt (status only)', () => {
    const E = d(-20);
    const r = sendInvoiceTransition(facts({ ...base, subscriptionEndedAt: E }), 'active', invoiced(E));
    expect(r.patch.subscriptionEndedAt).toBeUndefined();
  });

  it('switched collection method: an open null-due invoice with pastDueSince set → stays suspended on that anchor', () => {
    const P = d(-20);
    const f = facts({ ...base, pastDueSince: P, status: 'suspended', suspendedAt: d(-5), suspensionReason: 'nonpayment' });
    const r = sendInvoiceTransition(f, 'active', invoiced(computeInvoiceOverdueSince([inv({ dueDate: null })], 'si', P, null, NOW)));
    expect(r.patch.pastDueSince?.getTime()).toBe(P.getTime());
    expect(r.patch.status).toBeUndefined();
  });

  it('invoiceFacts skipped (deleteTenant) → no dunning or suspension field in the patch', () => {
    const f = facts({ ...base, pastDueSince: d(-20), status: 'suspended', suspendedAt: d(-5), suspensionReason: 'nonpayment', subscriptionEndedAt: d(-1) });
    const r = sendInvoiceTransition(f, 'active', { kind: 'skipped' }, { plan: 'standard', interval: 'year' });
    for (const k of [...DUNNING_FIELDS, 'firstGoodAt'] as const) expect(r.patch[k], k).toBeUndefined();
    expect(r.patch.plan).toBe('standard');
    expect(r.notices).toEqual([]);
  });

  it('charge_automatically keeps today\'s rule: DUNNING first seen → now; an existing anchor is kept', () => {
    const subs = [sub('c', 'past_due')];
    const first = computeSubscriptionTransition(facts({ subscriptionStatus: 'active', stripeSubscriptionId: 'c', firstGoodAt: d(-60) }), subs[0], subs, false, NOW);
    expect(first.patch.pastDueSince?.getTime()).toBe(NOW.getTime());
    const P = d(-4);
    const later = computeSubscriptionTransition(facts({ subscriptionStatus: 'past_due', stripeSubscriptionId: 'c', pastDueSince: P, firstGoodAt: d(-60) }), subs[0], subs, false, NOW, { kind: 'charge' });
    expect(later.patch.pastDueSince?.getTime()).toBe(P.getTime());
  });

  it('a send_invoice subscription given charge facts (no invoice read) follows the generic branches', () => {
    const r = sendInvoiceTransition(facts({ ...base, pastDueSince: d(-4) }), 'active', { kind: 'charge' });
    expect(r.patch.pastDueSince).toBeNull(); // generic GOOD
  });
});

describe('U5: GOOD reconcile facts', () => {
  it('on the annual price → plan standard, planInterval year', () => {
    const r = transition(facts(), [sub('s', 'active', { plan: 'standard', interval: 'year' })], null);
    expect(r.patch.plan).toBe('standard');
    expect(r.patch.planInterval).toBe('year');
  });

  it('on an unknown (custom) price → neither plan nor planInterval is set', () => {
    const r = transition(facts(), [sub('s', 'active', { plan: null, interval: null })], null);
    expect('plan' in r.patch).toBe(false);
    expect('planInterval' in r.patch).toBe(false);
  });

  it('cancelAtPeriodEnd and collectionMethod are patched on every tracked read (GOOD, DUNNING, canceled)', () => {
    for (const status of ['active', 'past_due', 'canceled', 'incomplete']) {
      const r = transition(facts({ firstGoodAt: d(-50), stripeSubscriptionId: 's' }), [sub('s', status, { cancelAtPeriodEnd: true, collectionMethod: 'send_invoice' })]);
      expect(r.patch.subscriptionCancelAtPeriodEnd, status).toBe(true);
      expect(r.patch.collectionMethod, status).toBe('send_invoice');
    }
  });

  it('GOOD send_invoice with an open invoice not yet due → plan standard and planInterval written (on Standard from day one)', () => {
    const r = sendInvoiceTransition(facts(), 'active', invoiced(null), { plan: 'standard', interval: 'year' });
    expect(r.patch.plan).toBe('standard');
    expect(r.patch.planInterval).toBe('year');
    expect(r.patch.firstGoodAt?.getTime()).toBe(NOW.getTime());
  });
});

// SWEEP-FINDINGS.md §2 decision 3 / §5 A2-D1: no payment emails while a workspace is policy-held; they resume once the
// hold is lifted (the next reconcile queues them again).
describe('A2-D1: no payment-failed while policy-held; it resumes after unsuspend', () => {
  const held = { status: 'suspended', suspendedAt: d(-2), suspensionReason: 'policy' } as const;
  const lifted = { status: 'active', suspendedAt: null, suspensionReason: null } as const;

  it('DUNNING under a policy hold records past_due_since but queues no payment-failed', () => {
    const r = transition(facts({ subscriptionStatus: 'active', stripeSubscriptionId: 's', firstGoodAt: d(-60), ...held }), [sub('s', 'past_due')]);
    expect(r.patch.pastDueSince?.getTime()).toBe(NOW.getTime());
    expect(r.notices).toEqual([]);
    expect(r.patch.status).toBeUndefined(); // the hold stays
  });

  it('after unsuspend, the same DUNNING reconcile queues payment-failed for the SAME anchor (resume)', () => {
    const P = d(-5);
    const before = transition(facts({ subscriptionStatus: 'past_due', stripeSubscriptionId: 's', firstGoodAt: d(-60), pastDueSince: P, ...held }), [sub('s', 'past_due')]);
    expect(before.notices).toEqual([]);
    const after = transition(facts({ subscriptionStatus: 'past_due', stripeSubscriptionId: 's', firstGoodAt: d(-60), pastDueSince: P, ...lifted }), [sub('s', 'past_due')]);
    expect(after.notices).toEqual([{ kind: 'payment-failed', anchor: P }]);
  });

  it('a non-payment suspension still gets payment-failed (only the policy reason holds it)', () => {
    const r = transition(facts({ subscriptionStatus: 'past_due', stripeSubscriptionId: 's', firstGoodAt: d(-60), pastDueSince: d(-20), status: 'suspended', suspendedAt: d(-5), suspensionReason: 'nonpayment' }), [sub('s', 'unpaid')]);
    expect(r.notices).toEqual([{ kind: 'payment-failed', anchor: d(-20) }]);
  });

  it('invoiced and overdue under a policy hold → pastDueSince = the due date, no payment-failed ("Invoice overdue")', () => {
    const P2 = d(-3);
    const base = { subscriptionStatus: 'active', stripeSubscriptionId: 'si', firstGoodAt: d(-100), collectionMethod: 'send_invoice' } as const;
    const r = sendInvoiceTransition(facts({ ...base, ...held }), 'active', invoiced(P2));
    expect(r.patch.pastDueSince?.getTime()).toBe(P2.getTime());
    expect(r.notices).toEqual([]);
    expect(r.patch.status).toBeUndefined();
    // Lifted: the same reconcile queues it (resume).
    const after = sendInvoiceTransition(facts({ ...base, ...lifted, pastDueSince: P2 }), 'active', invoiced(P2));
    expect(after.notices).toEqual([{ kind: 'payment-failed', anchor: P2 }]);
  });

  it('Q1 (lead, 2026-11-19): a held bank-payment-failed is not re-queued, but an unpaid invoice after unsuspend yields payment-failed', () => {
    const anchor = d(-1);
    const heldFacts = facts({ subscriptionStatus: 'past_due', stripeSubscriptionId: 's', firstGoodAt: d(-60), pastDueSince: d(-1), ...held });
    expect(isNoticeSuperseded('bank-payment-failed', anchor, heldFacts, NOW)).toBe(true);
    const r = transition(facts({ subscriptionStatus: 'past_due', stripeSubscriptionId: 's', firstGoodAt: d(-60), pastDueSince: d(-1), ...lifted }), [sub('s', 'past_due')]);
    expect(r.notices.map((n) => n.kind)).toEqual(['payment-failed']);
  });
});
