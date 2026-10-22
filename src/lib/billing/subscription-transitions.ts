/**
 * Stripe → lifecycle transitions — the PURE half of the webhook and reconcile
 * (feature-plan-terms-compliance-fixes.md §4.3). Callers read Stripe (never the mirror), call these, and apply
 * the result under the tenant lock with the version guard.
 */
import {
  addDays,
  deletionDateFrom,
  isDunning,
  isGood,
  isLive,
  type LifecycleFacts,
  type NoticeKind,
} from '@/lib/tenant/lifecycle';
import { POST_END_RETENTION_DAYS } from '@/lib/tenant/lifecycle-config';

/** What we read from Stripe for one subscription. */
export interface StripeSubSnapshot {
  id: string;
  status: string;
  created: Date;
  endedAt: Date | null;
  currentPeriodEnd: Date | null;
  plan: string | null;
}

/**
 * §4.3 rule 4: which subscription counts. Prefers a paying one, so a paying duplicate is never ignored in
 * favor of a dunning tracked subscription: tracked if GOOD; else newest GOOD; else tracked if LIVE; else newest
 * LIVE; else newest incomplete; else tracked; else newest.
 */
export function selectTracked(
  subs: StripeSubSnapshot[],
  trackedId: string | null,
): { tracked: StripeSubSnapshot | null; duplicateLive: boolean } {
  const newestFirst = [...subs].sort((a, b) => b.created.getTime() - a.created.getTime());
  const tracked = trackedId ? newestFirst.find((s) => s.id === trackedId) ?? null : null;
  const pick =
    (tracked && isGood(tracked.status) ? tracked : null)
    ?? newestFirst.find((s) => isGood(s.status))
    ?? (tracked && isLive(tracked.status) ? tracked : null)
    ?? newestFirst.find((s) => isLive(s.status))
    ?? newestFirst.find((s) => s.status === 'incomplete')
    ?? tracked
    ?? newestFirst[0]
    ?? null;
  return { tracked: pick, duplicateLive: subs.filter((s) => isLive(s.status)).length > 1 };
}

/** The fact changes, notices and alerts for one transition. Facts not mentioned are left unchanged. */
export interface TransitionResult {
  patch: Partial<{
    stripeSubscriptionId: string;
    subscriptionStatus: string;
    currentPeriodEnd: Date | null;
    plan: string;
    firstGoodAt: Date;
    pastDueSince: Date | null;
    suspendedAt: Date | null;
    suspensionReason: 'nonpayment' | 'policy' | null;
    subscriptionEndedAt: Date | null;
    deletionScheduledFor: Date | null;
    status: 'active' | 'suspended';
  }>;
  notices: Array<{ kind: NoticeKind; anchor: Date }>;
  alerts: Array<{ kind: string; dedupKey?: string; detail?: Record<string, unknown> }>;
}

/**
 * §4.3 transition table. `all` is every subscription listed for the customer (for the lost-cancellation rule and
 * the duplicate alert); `tracked` is the selection from `selectTracked`.
 */
export function computeSubscriptionTransition(
  f: LifecycleFacts,
  tracked: StripeSubSnapshot | null,
  all: StripeSubSnapshot[],
  duplicateLive: boolean,
  now: Date,
): TransitionResult {
  const result: TransitionResult = { patch: {}, notices: [], alerts: [] };
  if (duplicateLive) {
    result.alerts.push({ kind: 'duplicate-live-subscriptions', detail: { ids: all.filter((s) => isLive(s.status)).map((s) => s.id) } });
  }
  const notPolicy = f.suspensionReason !== 'policy';
  if (!tracked) {
    // Nothing on the customer at all. A paid-before tenant whose end was never recorded still ends (at `now`,
    // with an alert — never throw every run); anyone else: bookkeeping only.
    if (f.firstGoodAt !== null && f.subscriptionEndedAt === null) applyEnded(result, f, null, now, notPolicy);
    return result;
  }

  const p = result.patch;
  p.stripeSubscriptionId = tracked.id;
  p.subscriptionStatus = tracked.status;
  p.currentPeriodEnd = tracked.currentPeriodEnd;

  // A paid-before tenant with nothing LIVE whose end was never recorded: apply the cancellation using the newest
  // canceled subscription (a lost `subscription.deleted` followed by a new incomplete checkout can't hide it).
  const nothingLive = !all.some((s) => isLive(s.status));
  if (f.firstGoodAt !== null && f.subscriptionEndedAt === null && nothingLive && tracked.status !== 'canceled') {
    const lastCanceled = [...all].filter((s) => s.status === 'canceled')
      .sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0))[0];
    applyEnded(result, f, lastCanceled?.endedAt ?? null, now, notPolicy);
    return result;
  }

  if (isGood(tracked.status)) {
    if (tracked.plan) p.plan = tracked.plan;
    p.firstGoodAt = f.firstGoodAt ?? now;
    p.pastDueSince = null;
    p.subscriptionEndedAt = null;
    p.deletionScheduledFor = null;
    if (notPolicy) {
      p.suspendedAt = null;
      p.suspensionReason = null;
      p.status = 'active';
    }
    return result;
  }

  if (isDunning(tracked.status)) {
    if (f.subscriptionEndedAt === null) {
      p.firstGoodAt = f.firstGoodAt ?? now; // past_due/unpaid implies the subscription was active
      const P = f.pastDueSince ?? now;
      p.pastDueSince = P;
      result.notices.push({ kind: 'payment-failed', anchor: P });
    }
    return result;
  }

  if (tracked.status === 'canceled') {
    if (f.firstGoodAt !== null && f.subscriptionEndedAt === null) {
      applyEnded(result, f, tracked.endedAt, now, notPolicy);
    }
    return result; // canceled-never-GOOD (trial rules) or already ended: status only
  }

  if (tracked.status === 'paused') {
    result.alerts.push({ kind: 'paused-subscription', dedupKey: tracked.id });
  }
  return result; // incomplete / incomplete_expired / paused: status only
}

function applyEnded(result: TransitionResult, f: LifecycleFacts, endedAt: Date | null, now: Date, notPolicy: boolean): void {
  const p = result.patch;
  const E = endedAt ?? now;
  if (!endedAt) result.alerts.push({ kind: 'cancellation-time-unknown' });
  // Keep the tracked subscription's real status (e.g. a new `incomplete` checkout) so reconcile still watches it;
  // only with nothing tracked does the mirror become 'canceled'.
  if (p.subscriptionStatus === undefined) p.subscriptionStatus = 'canceled';
  p.subscriptionEndedAt = E;
  // F1: an exempt workspace is never scheduled for deletion and gets no lifecycle emails.
  if (!f.lifecycleExempt) p.deletionScheduledFor = deletionDateFrom(addDays(E, POST_END_RETENTION_DAYS), now);
  p.pastDueSince = null;
  if (notPolicy) {
    p.suspendedAt = null;
    p.suspensionReason = null;
    p.status = 'active';
    if (!f.lifecycleExempt) result.notices.push({ kind: 'subscription-ended', anchor: E });
  } else {
    // §9.2: a §6/§7 breach gets no export window — the workspace stays suspended and no "90 days to export"
    // email is sent (it would promise what the Terms withhold). The founder decides; the alert surfaces it.
    result.alerts.push({ kind: 'policy-suspended-subscription-ended' });
  }
}
