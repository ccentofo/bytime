import { describe, it, expect } from 'vitest';
import {
  getTenantAccess,
  canExport,
  nextLifecycleActions,
  isNoticeSuperseded,
  shouldReconcile,
  deletionDateFrom,
  addDays,
  type LifecycleFacts,
  type NoticeState,
  type ReconcileContext,
} from '@/lib/tenant/lifecycle';

// feature-plan-terms-compliance-fixes.md §4 / §7: table-driven tests for every access row and every cron rule,
// including the scenarios that broke the first implementation (paying customer treated as a lapsed trial,
// re-suspension after termination, ACH in flight, undeliverable notices).

const NOW = new Date('2026-06-15T12:00:00Z');
const d = (days: number) => addDays(NOW, days);

function facts(overrides: Partial<LifecycleFacts> = {}): LifecycleFacts {
  return {
    status: 'active',
    subscriptionStatus: null,
    stripeSubscriptionId: null,
    trialEndsAt: d(10),
    pastDueSince: null,
    suspendedAt: null,
    suspensionReason: null,
    subscriptionEndedAt: null,
    deletionScheduledFor: null,
    firstGoodAt: null,
    lifecycleExempt: false,
    policyExportAllowed: false,
    ...overrides,
  };
}

const paying = { subscriptionStatus: 'active', stripeSubscriptionId: 'sub_1', firstGoodAt: d(-200), trialEndsAt: d(-230) };

function sent(kind: string, anchor: Date, at: Date): NoticeState {
  return { kind, anchor, sentAt: at, forcedAt: null, supersededAt: null, createdAt: at };
}
function pending(kind: string, anchor: Date, createdAt: Date): NoticeState {
  return { kind, anchor, sentAt: null, forcedAt: null, supersededAt: null, createdAt };
}

const run = (f: LifecycleFacts, notices: NoticeState[] = [], paymentProcessing = false, now = NOW) =>
  nextLifecycleActions(f, notices, { paymentProcessing }, now);
const kinds = (a: ReturnType<typeof run>) => a.enqueue.map((n) => n.kind);

describe('getTenantAccess (§4.2)', () => {
  const cases: Array<[string, Partial<LifecycleFacts>, string]> = [
    ['1 provisioning → closed', { status: 'provisioning' }, 'closed'],
    ['1 deleting → closed', { status: 'deleting', ...paying }, 'closed'],
    ['1 deleted → closed', { status: 'deleted' }, 'closed'],
    ['2 past the deletion date → closed', { subscriptionEndedAt: d(-100), deletionScheduledFor: d(-1) }, 'closed'],
    ['3 suspended (nonpayment) → billing_only', { ...paying, subscriptionStatus: 'past_due', status: 'suspended', suspensionReason: 'nonpayment' }, 'billing_only'],
    ['3 suspended (policy) → policy_hold (F5)', { ...paying, status: 'suspended', suspensionReason: 'policy' }, 'policy_hold'],
    ['2 before 3: a policy hold past its deletion date is closed', { ...paying, status: 'suspended', suspensionReason: 'policy', deletionScheduledFor: d(-1) }, 'closed'],
    ['4 terminated / subscription ended → read_only', { ...paying, subscriptionStatus: 'canceled', subscriptionEndedAt: d(-1), deletionScheduledFor: d(89) }, 'read_only'],
    ['4 canceled after paying with no trial date → read_only', { ...paying, trialEndsAt: null, subscriptionStatus: 'canceled', subscriptionEndedAt: d(-5), deletionScheduledFor: d(85) }, 'read_only'],
    ['5 converted customer past an old trial date → full', paying, 'full'],
    ['5 dunning day 1 → full (grace)', { ...paying, subscriptionStatus: 'past_due', pastDueSince: d(-1) }, 'full'],
    ['5 dunning day 14 → full (grace)', { ...paying, subscriptionStatus: 'unpaid', pastDueSince: d(-14) }, 'full'],
    ['5 paused → full', { ...paying, subscriptionStatus: 'paused' }, 'full'],
    ['6 exempt demo with a lapsed trial → full', { lifecycleExempt: true, trialEndsAt: d(-400) }, 'full'],
    ['7 trial active → full', { trialEndsAt: d(5) }, 'full'],
    ['7 incomplete checkout during trial → trial rules (full)', { subscriptionStatus: 'incomplete', stripeSubscriptionId: 'sub_x', trialEndsAt: d(5) }, 'full'],
    ['8 trial ended, never subscribed → read_only', { trialEndsAt: d(-1) }, 'read_only'],
    ['8 canceled never-GOOD subscription during a lapsed trial → trial rules (read_only)', { subscriptionStatus: 'canceled', trialEndsAt: d(-1) }, 'read_only'],
    ['9 missing trial date, never subscribed → full (cron alerts)', { trialEndsAt: null }, 'full'],
    ['10 paid before, canceled, end not recorded → read_only', { ...paying, subscriptionStatus: 'canceled' }, 'read_only'],
    ['10 paid before, canceled, end not recorded, NO trial date → read_only (never "missing trial date" full)', { ...paying, trialEndsAt: null, subscriptionStatus: 'canceled' }, 'read_only'],
    ['re-subscribed during the 90-day window → full', { ...paying, subscriptionEndedAt: null, deletionScheduledFor: null }, 'full'],
  ];
  for (const [name, overrides, mode] of cases) {
    it(name, () => expect(getTenantAccess(facts(overrides), NOW)).toBe(mode));
  }
});

describe('canExport (D6/D8, F5)', () => {
  it('full, read_only and billing_only (non-payment) may export', () => {
    expect(canExport(facts({ ...paying }), NOW)).toBe(true);
    expect(canExport(facts({ trialEndsAt: d(-1) }), NOW)).toBe(true);
    expect(canExport(facts({ ...paying, status: 'suspended', suspensionReason: 'nonpayment' }), NOW)).toBe(true);
  });
  it('a policy hold blocks export by default', () => {
    expect(canExport(facts({ ...paying, status: 'suspended', suspensionReason: 'policy' }), NOW)).toBe(false);
  });
  it('a policy hold may export once the founder allowed it', () => {
    expect(canExport(facts({ ...paying, status: 'suspended', suspensionReason: 'policy', policyExportAllowed: true }), NOW)).toBe(true);
  });
  it('a leftover allowance never matters outside a policy hold; closed never exports', () => {
    expect(canExport(facts({ status: 'deleting', policyExportAllowed: true }), NOW)).toBe(false);
    expect(canExport(facts({ ...paying, status: 'suspended', suspensionReason: 'policy', policyExportAllowed: true, deletionScheduledFor: d(-1) }), NOW)).toBe(false);
  });
});

describe('policy-suspended notice supersession (F5)', () => {
  const Sa = d(-1);
  const held = facts({ ...paying, status: 'suspended', suspensionReason: 'policy', suspendedAt: Sa });
  it('is current while the same policy hold lasts', () => {
    expect(isNoticeSuperseded('policy-suspended', Sa, held, NOW)).toBe(false);
  });
  it('is superseded once lifted, or for a different hold', () => {
    expect(isNoticeSuperseded('policy-suspended', Sa, { ...held, status: 'active', suspensionReason: null, suspendedAt: null }, NOW)).toBe(true);
    expect(isNoticeSuperseded('policy-suspended', Sa, { ...held, suspendedAt: d(-3) }, NOW)).toBe(true);
  });
});

describe('deletionDateFrom (deletion-date rule)', () => {
  it('never returns a date in the past', () => {
    expect(deletionDateFrom(d(-50), NOW).getTime()).toBe(d(14).getTime());
  });
  it('keeps a later computed date', () => {
    expect(deletionDateFrom(d(60), NOW).getTime()).toBe(d(60).getTime());
  });
});

describe('nextLifecycleActions — trial (§4.4)', () => {
  it('a converted (paying) customer never gets trial notices, even long past the old trial date', () => {
    const a = run(facts(paying));
    expect(kinds(a)).toEqual([]);
    expect(a.setDeletionScheduledFor).toBeUndefined();
  });
  it('a dunning customer never gets trial notices or a deletion date (the first-implementation bug)', () => {
    const a = run(facts({ ...paying, subscriptionStatus: 'past_due', pastDueSince: d(-1) }));
    expect(kinds(a)).not.toContain('trial-ended');
    expect(a.setDeletionScheduledFor).toBeUndefined();
  });
  it('7-day reminder in its window', () => {
    expect(kinds(run(facts({ trialEndsAt: d(5) })))).toEqual(['trial-reminder-7d']);
  });
  it('only the nearest reminder after missed days (1-day window)', () => {
    expect(kinds(run(facts({ trialEndsAt: addDays(NOW, 0.5) })))).toEqual(['trial-reminder-1d']);
  });
  it('trial ended → trial-ended notice and D = T + 90d', () => {
    const T = d(-1);
    const a = run(facts({ trialEndsAt: T }));
    expect(kinds(a)).toContain('trial-ended');
    expect(a.setDeletionScheduledFor?.getTime()).toBe(addDays(T, 90).getTime());
  });
  it('trial ended long ago (late-enabled cron) → D is never in the past', () => {
    const a = run(facts({ trialEndsAt: d(-200) }));
    expect(a.setDeletionScheduledFor?.getTime()).toBe(d(14).getTime());
  });
  it('trial ends on schedule when no reminder could be delivered (F4) — and the founder is alerted', () => {
    const T = d(-1);
    const notices = [{ ...pending('trial-reminder-1d', T, d(-2)), supersededAt: T }];
    const a = run(facts({ trialEndsAt: T }), notices);
    expect(getTenantAccess(facts({ trialEndsAt: T }), NOW)).toBe('read_only');
    expect(a.alerts).toContainEqual({ kind: 'undeliverable-trial-reminder', anchor: T });
  });
  it('no undeliverable-reminder alert when the other reminder for T was delivered', () => {
    const T = d(-1);
    const notices = [{ ...pending('trial-reminder-7d', T, d(-8)), supersededAt: d(-2) }, sent('trial-reminder-1d', T, d(-2))];
    expect(run(facts({ trialEndsAt: T }), notices).alerts.map((x) => x.kind)).not.toContain('undeliverable-trial-reminder');
  });
  it('no undeliverable-reminder alert for an exempt (demo) workspace', () => {
    const T = d(-1);
    const notices = [{ ...pending('trial-reminder-1d', T, d(-2)), supersededAt: T }];
    expect(run(facts({ trialEndsAt: T, lifecycleExempt: true }), notices).alerts.map((x) => x.kind)).not.toContain('undeliverable-trial-reminder');
  });
  it('paid before, canceled, end not yet recorded → no trial notices and no trial-based deletion date', () => {
    const a = run(facts({ ...paying, subscriptionStatus: 'canceled' }));
    expect(kinds(a)).not.toContain('trial-ended');
    expect(a.setDeletionScheduledFor).toBeUndefined();
    expect(a.alerts).not.toContainEqual({ kind: 'missing-trial-date' });
  });
  it('missing trial date → alert', () => {
    expect(run(facts({ trialEndsAt: null })).alerts).toContainEqual({ kind: 'missing-trial-date' });
  });
  it('exempt tenants are untouched', () => {
    const a = run(facts({ lifecycleExempt: true, trialEndsAt: d(-300) }));
    expect(kinds(a)).toEqual([]);
    expect(a.setDeletionScheduledFor).toBeUndefined();
  });
});

describe('nextLifecycleActions — dunning and suspension (§4.4, D7)', () => {
  const P = d(-20);
  const dunning = facts({ ...paying, subscriptionStatus: 'past_due', pastDueSince: P });
  it('warning enqueued from P + 12d', () => {
    expect(kinds(run(facts({ ...paying, subscriptionStatus: 'past_due', pastDueSince: d(-12) })))).toContain('suspension-warning');
  });
  it('no suspension before the warning was given (Terms §4.7 "after notice")', () => {
    expect(run(dunning, [pending('suspension-warning', P, d(-8))]).suspend).toBeUndefined();
  });
  it('suspends at max(P + 15d, warning + 3d)', () => {
    expect(run(dunning, [sent('suspension-warning', P, d(-8))]).suspend).toBe(true);
  });
  it('waits 3 days after a late warning', () => {
    expect(run(dunning, [sent('suspension-warning', P, d(-1))]).suspend).toBeUndefined();
  });
  it('defers suspension while an ACH payment is processing', () => {
    expect(run(dunning, [sent('suspension-warning', P, d(-8))], true).suspend).toBeUndefined();
  });
  it('a forced (founder-overridden) warning counts as given', () => {
    const forced = { ...pending('suspension-warning', P, d(-8)), forcedAt: d(-8) };
    expect(run(dunning, [forced]).suspend).toBe(true);
  });
  it('an undeliverable warning blocks suspension and raises an alert after 2 days', () => {
    const a = run(dunning, [pending('suspension-warning', P, d(-5))]);
    expect(a.suspend).toBeUndefined();
    expect(a.alerts).toContainEqual({ kind: 'blocked-transition', notice: 'suspension-warning', anchor: P });
  });
  it('a suspended tenant is never suspended again (suspended_at stays put)', () => {
    const f = facts({ ...paying, subscriptionStatus: 'past_due', pastDueSince: P, status: 'suspended', suspendedAt: d(-3), suspensionReason: 'nonpayment' });
    expect(run(f, [sent('suspension-warning', P, d(-8))]).suspend).toBeUndefined();
  });
  it('dunning after termination does not restart grace', () => {
    const f = facts({ ...paying, subscriptionStatus: 'past_due', pastDueSince: P, subscriptionEndedAt: d(-1), deletionScheduledFor: d(89) });
    const a = run(f, [sent('suspension-warning', P, d(-8))]);
    expect(a.suspend).toBeUndefined();
    expect(kinds(a)).not.toContain('suspension-warning');
  });
});

describe('nextLifecycleActions — D9 termination', () => {
  const Sa = d(-31);
  const suspended = facts({ ...paying, subscriptionStatus: 'unpaid', pastDueSince: d(-46), status: 'suspended', suspendedAt: Sa, suspensionReason: 'nonpayment' });
  it('terminates 30 days after suspension once the suspended notice was given', () => {
    expect(run(suspended, [sent('suspended', Sa, Sa)]).terminate).toBe(true);
  });
  it('waits for the suspended notice', () => {
    expect(run(suspended, [pending('suspended', Sa, Sa)]).terminate).toBeUndefined();
  });
  it('defers termination while an ACH payment is processing', () => {
    expect(run(suspended, [sent('suspended', Sa, Sa)], true).terminate).toBeUndefined();
  });
  it('never terminates a policy suspension', () => {
    expect(run(facts({ ...suspended, suspensionReason: 'policy' }), [sent('suspended', Sa, Sa)]).terminate).toBeUndefined();
  });
  it('a terminated tenant is read_only (not re-suspended) the next day', () => {
    const terminated = facts({ ...paying, subscriptionStatus: 'canceled', subscriptionEndedAt: d(-1), deletionScheduledFor: d(89) });
    expect(getTenantAccess(terminated, NOW)).toBe('read_only');
    expect(run(terminated).suspend).toBeUndefined();
  });
});

describe('nextLifecycleActions — retention window and deletion (D3, D4)', () => {
  const E = d(-80);
  const ended = (D: Date) => facts({ ...paying, subscriptionStatus: 'canceled', subscriptionEndedAt: E, deletionScheduledFor: D });
  it('deletion notice from D − 14d, anchored on the subscription end', () => {
    const a = run(ended(d(10)));
    expect(a.enqueue).toContainEqual({ kind: 'deletion-notice', anchor: E });
  });
  it('a late-delivered notice pushes D so the notice period is never shortened', () => {
    const a = run(ended(d(10)), [sent('deletion-notice', E, d(0))]);
    expect(a.setDeletionScheduledFor?.getTime()).toBe(d(14).getTime());
  });
  it('final reminder at D − 3d', () => {
    expect(kinds(run(ended(d(2)), [sent('deletion-notice', E, d(-12))]))).toContain('deletion-final-reminder');
  });
  it('ready for deletion only with a current-anchor notice sent ≥ 14 days before D', () => {
    expect(run(ended(d(-1)), [sent('deletion-notice', E, d(-15))]).readyForDeletion).toBe(true);
  });
  it('a notice for an older anchor does not count', () => {
    const old = sent('deletion-notice', d(-300), d(-290));
    expect(run(ended(d(-1)), [old]).readyForDeletion).toBeUndefined();
  });
  it('no deletion notice delivered by D → blocked-transition alert, not ready', () => {
    const a = run(ended(d(-1)), [pending('deletion-notice', E, d(-15))]);
    expect(a.readyForDeletion).toBeUndefined();
    expect(a.alerts).toContainEqual({ kind: 'blocked-transition', notice: 'deletion-notice', anchor: E });
  });
});

describe('isNoticeSuperseded (§4.5)', () => {
  const T = d(3);
  it('trial reminder superseded once the customer subscribes', () => {
    expect(isNoticeSuperseded('trial-reminder-7d', T, facts({ ...paying, trialEndsAt: T }), NOW)).toBe(true);
  });
  it('trial reminder superseded after extend-trial changes T', () => {
    expect(isNoticeSuperseded('trial-reminder-7d', T, facts({ trialEndsAt: d(20) }), NOW)).toBe(true);
  });
  it('7-day reminder superseded once inside the 1-day window', () => {
    expect(isNoticeSuperseded('trial-reminder-7d', T, facts({ trialEndsAt: T }), addDays(T, -0.5))).toBe(true);
  });
  it('trial reminder still applies in its window', () => {
    expect(isNoticeSuperseded('trial-reminder-7d', T, facts({ trialEndsAt: T }), NOW)).toBe(false);
  });
  it('payment-failed superseded after the customer paid (past_due_since cleared)', () => {
    expect(isNoticeSuperseded('payment-failed', d(-2), facts(paying), NOW)).toBe(true);
  });
  it('suspension-warning superseded after termination', () => {
    const P = d(-14);
    expect(isNoticeSuperseded('suspension-warning', P, facts({ ...paying, pastDueSince: P, subscriptionEndedAt: d(-1) }), NOW)).toBe(true);
  });
  it('deletion notice superseded after re-subscribing (D cleared)', () => {
    expect(isNoticeSuperseded('deletion-notice', d(-80), facts(paying), NOW)).toBe(true);
  });
  it('trial-ended superseded for an exempt tenant', () => {
    expect(isNoticeSuperseded('trial-ended', d(-1), facts({ trialEndsAt: d(-1), lifecycleExempt: true }), NOW)).toBe(true);
  });
  it('every notice superseded for a deleting tenant', () => {
    expect(isNoticeSuperseded('subscription-ended', d(-1), facts({ status: 'deleting', subscriptionEndedAt: d(-1) }), NOW)).toBe(true);
  });
});

describe('shouldReconcile (§4.4 step 1)', () => {
  const ctx = (o: Partial<ReconcileContext> = {}): ReconcileContext => ({
    hasStripeCustomer: true, stripeCustomerDeleted: false, currentPeriodEnd: d(20), deletionAbortedSinceLastCheck: false, ...o,
  });
  it('no Stripe customer → never', () => expect(shouldReconcile(facts(), ctx({ hasStripeCustomer: false }), NOW)).toBe(false));
  it('customer but no tracked subscription (lost checkout events) → yes', () => expect(shouldReconcile(facts(), ctx(), NOW)).toBe(true));
  it('deleted customer with nothing tracked → no (never fails every run)', () =>
    expect(shouldReconcile(facts(), ctx({ stripeCustomerDeleted: true }), NOW)).toBe(false));
  it('dunning → yes', () => expect(shouldReconcile(facts({ ...paying, subscriptionStatus: 'past_due' }), ctx(), NOW)).toBe(true));
  it('incomplete (lost incomplete→active) → yes', () =>
    expect(shouldReconcile(facts({ subscriptionStatus: 'incomplete', stripeSubscriptionId: 'sub_x' }), ctx(), NOW)).toBe(true));
  it('GOOD with a fresh period end → no', () => expect(shouldReconcile(facts(paying), ctx(), NOW)).toBe(false));
  it('GOOD past its period end (lost renewal/cancel) → yes', () =>
    expect(shouldReconcile(facts(paying), ctx({ currentPeriodEnd: d(-3) }), NOW)).toBe(true));
  it('paid before, not live, end not recorded → yes (repair)', () =>
    expect(shouldReconcile(facts({ ...paying, subscriptionStatus: 'canceled' }), ctx(), NOW)).toBe(true));
  it('due for deletion → yes', () =>
    expect(shouldReconcile(facts({ ...paying, subscriptionStatus: 'canceled', subscriptionEndedAt: d(-100), deletionScheduledFor: d(-1) }), ctx(), NOW)).toBe(true));
  it('deletion aborted since the last check → yes', () =>
    expect(shouldReconcile(facts(paying), ctx({ deletionAbortedSinceLastCheck: true }), NOW)).toBe(true));
});
