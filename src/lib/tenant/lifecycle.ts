/**
 * Tenant billing/lifecycle state machine — the PURE decision layer.
 *
 * Implements feature-plan-terms-compliance-fixes.md §4 (v12, CLEAN after pre-mortem review). Everything here is
 * pure: no DB, no Stripe, no clock reads. `now` is always passed in. Callers (registry/context for access,
 * the Stripe webhook and lifecycle cron for transitions, notice delivery for supersession) read facts, call
 * these functions, and apply the result under the tenant lock with the `lifecycle_version` guard.
 *
 * Business values come only from lifecycle-config.ts (§0 decisions D1–D13, F1–F5).
 */
import {
  TRIAL_REMINDER_DAYS_BEFORE,
  POST_END_RETENTION_DAYS,
  DELETION_NOTICE_DAYS,
  DELETION_FINAL_REMINDER_DAYS,
  PAYMENT_GRACE_DAYS,
  SUSPENSION_NOTICE_DAYS,
  SUSPENDED_DAYS_UNTIL_TERMINATION,
} from './lifecycle-config';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** Instants are compared by value, never by reference or `===` (§4.1 time rule). */
export function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

// ---------------------------------------------------------------------------
// Facts (§4.1)
// ---------------------------------------------------------------------------

export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted';
export type SuspensionReason = 'nonpayment' | 'policy';

/** The control-plane facts every lifecycle decision reads. Built by `toLifecycleFacts(row)` (registry.ts). */
export interface LifecycleFacts {
  status: TenantStatus;
  subscriptionStatus: string | null;
  stripeSubscriptionId: string | null;
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  suspendedAt: Date | null;
  suspensionReason: SuspensionReason | null;
  subscriptionEndedAt: Date | null;
  deletionScheduledFor: Date | null;
  firstGoodAt: Date | null;
  lifecycleExempt: boolean;
  /** F5: the founder allowed export for this policy-suspended workspace. */
  policyExportAllowed: boolean;
}

export const GOOD = ['active', 'trialing'] as const;
export const DUNNING = ['past_due', 'unpaid'] as const;
/** `paused` only occurs when a Stripe trial ends without a payment method; we don't use Stripe trials. */
export const LIVE = [...GOOD, ...DUNNING, 'paused'] as const;

export function isGood(status: string | null): boolean {
  return status !== null && (GOOD as readonly string[]).includes(status);
}
export function isDunning(status: string | null): boolean {
  return status !== null && (DUNNING as readonly string[]).includes(status);
}
export function isLive(status: string | null): boolean {
  return status !== null && (LIVE as readonly string[]).includes(status);
}

/** Ever paid, or currently LIVE. `incomplete`/`incomplete_expired`/canceled-never-GOOD follow trial rules. */
export function hasSubscribed(f: Pick<LifecycleFacts, 'firstGoodAt' | 'subscriptionEndedAt' | 'subscriptionStatus'>): boolean {
  return f.firstGoodAt !== null || f.subscriptionEndedAt !== null || isLive(f.subscriptionStatus);
}

/** The anchor of the 90-day retention window: the subscription end, else the trial end. */
export function cycleAnchor(f: Pick<LifecycleFacts, 'subscriptionEndedAt' | 'trialEndsAt'>): Date | null {
  return f.subscriptionEndedAt ?? f.trialEndsAt;
}

/**
 * §4.1 deletion-date rule: a newly set deletion date is never in the past and always leaves room for the
 * contractual notice.
 */
export function deletionDateFrom(computed: Date, now: Date): Date {
  return maxDate(computed, addDays(now, DELETION_NOTICE_DAYS));
}

// ---------------------------------------------------------------------------
// Access mode (§4.2) — first match wins
// ---------------------------------------------------------------------------

/**
 * `billing_only`: suspended for non-payment — admins see billing + export, everyone else is on hold (Terms §4.7).
 * `policy_hold`: suspended for a policy breach (F5) — everyone, admins included, sees the hold screen; no billing;
 * export only if the founder allowed it (`canExport`).
 */
export type TenantAccessMode = 'full' | 'read_only' | 'billing_only' | 'policy_hold' | 'closed';

export function getTenantAccess(f: LifecycleFacts, now: Date): TenantAccessMode {
  // 1
  if (f.status === 'provisioning' || f.status === 'deleting' || f.status === 'deleted') return 'closed';
  // 2
  if (f.deletionScheduledFor !== null && now.getTime() >= f.deletionScheduledFor.getTime()) return 'closed';
  // 3 — suspended: a policy breach is a hold (F5); non-payment keeps the billing screen
  if (f.status === 'suspended') return f.suspensionReason === 'policy' ? 'policy_hold' : 'billing_only';
  // 4
  if (f.subscriptionEndedAt !== null) return 'read_only';
  // 5 — includes DUNNING: grace keeps full access until the cron suspends (Terms §4.7)
  if (isLive(f.subscriptionStatus)) return 'full';
  // 6 — F1
  if (f.lifecycleExempt) return 'full';
  const subscribed = hasSubscribed(f);
  if (!subscribed && f.trialEndsAt !== null) {
    // 7 / 8 — trials end on schedule (F4)
    return now.getTime() < f.trialEndsAt.getTime() ? 'full' : 'read_only';
  }
  // 9 — data error (the cron raises a "missing trial date" alert); never silently closed
  if (!subscribed && f.trialEndsAt === null) return 'full';
  // 10 — default (e.g. paid before, canceled/incomplete now, end not yet recorded — the cron repairs it)
  return 'read_only';
}

/**
 * Whether an admin may run the full workspace export (D6/D8, F5): every non-closed mode, except a policy hold
 * unless the founder allowed it for that workspace.
 */
export function canExport(f: LifecycleFacts, now: Date): boolean {
  const mode = getTenantAccess(f, now);
  if (mode === 'closed') return false;
  if (mode === 'policy_hold') return f.policyExportAllowed;
  return true;
}

// ---------------------------------------------------------------------------
// Notices: state and supersession (§4.5)
// ---------------------------------------------------------------------------

export type NoticeKind =
  | 'trial-reminder-7d'
  | 'trial-reminder-1d'
  | 'trial-ended'
  | 'payment-failed'
  | 'suspension-warning'
  | 'suspended'
  | 'subscription-ended'
  | 'deletion-notice'
  | 'deletion-final-reminder'
  | 'policy-suspended';

/** What the cron needs to know about a notice row. `anchor` is the row's `scheduled_for`. */
export interface NoticeState {
  kind: string;
  anchor: Date;
  sentAt: Date | null;
  forcedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
}

/** When a notice counts as given: delivered (with a provider id) or forced by the founder. Null if not given. */
export function noticeGivenAt(notices: NoticeState[], kind: NoticeKind, anchor: Date | null): Date | null {
  if (anchor === null) return null;
  const row = notices.find((n) => n.kind === kind && sameInstant(n.anchor, anchor) && n.supersededAt === null);
  if (!row) return null;
  return row.sentAt ?? row.forcedAt ?? null;
}

/**
 * True if a pending notice no longer applies to the current facts and must be marked superseded instead of
 * sent (§4.5 Deliver step 2).
 */
export function isNoticeSuperseded(kind: string, anchor: Date, f: LifecycleFacts, now: Date): boolean {
  if (f.status === 'deleting' || f.status === 'deleted') return true;
  switch (kind) {
    case 'trial-reminder-7d':
    case 'trial-reminder-1d': {
      if (hasSubscribed(f) || f.lifecycleExempt || !sameInstant(f.trialEndsAt, anchor)) return true;
      if (now.getTime() >= anchor.getTime()) return true;
      if (kind === 'trial-reminder-7d' && now.getTime() >= addDays(anchor, -1).getTime()) return true;
      return false;
    }
    case 'trial-ended':
      return hasSubscribed(f) || f.lifecycleExempt || !sameInstant(f.trialEndsAt, anchor);
    case 'payment-failed':
    case 'suspension-warning':
      return !sameInstant(f.pastDueSince, anchor) || f.subscriptionEndedAt !== null;
    case 'suspended':
      return !sameInstant(f.suspendedAt, anchor);
    case 'policy-suspended':
      return f.status !== 'suspended' || f.suspensionReason !== 'policy' || !sameInstant(f.suspendedAt, anchor);
    case 'subscription-ended':
      return !sameInstant(f.subscriptionEndedAt, anchor);
    case 'deletion-notice':
    case 'deletion-final-reminder':
      return !sameInstant(cycleAnchor(f), anchor) || f.deletionScheduledFor === null;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Reconcile triggers (§4.4 step 1)
// ---------------------------------------------------------------------------

export interface ReconcileContext {
  hasStripeCustomer: boolean;
  stripeCustomerDeleted: boolean;
  currentPeriodEnd: Date | null;
  /** A `deletion-aborted` audit event was recorded since the tenant was last checked. */
  deletionAbortedSinceLastCheck: boolean;
}

/** Whether the cron must read Stripe for this tenant before evaluating rules (a mirror may be stale). */
export function shouldReconcile(f: LifecycleFacts, ctx: ReconcileContext, now: Date): boolean {
  if (!ctx.hasStripeCustomer) return false;
  const tracked = f.stripeSubscriptionId !== null;
  if (!tracked) return !ctx.stripeCustomerDeleted; // customer set (not deleted) but nothing tracked yet
  if (isDunning(f.subscriptionStatus)) return true;
  if (f.subscriptionStatus === 'incomplete') return true;
  if (f.status === 'suspended' && f.suspensionReason === 'nonpayment') return true;
  if (f.subscriptionEndedAt !== null && isLive(f.subscriptionStatus)) return true; // ended, Stripe not canceled
  if (isGood(f.subscriptionStatus) && ctx.currentPeriodEnd !== null
      && ctx.currentPeriodEnd.getTime() < addDays(now, -1).getTime()) return true;
  if (f.firstGoodAt !== null && f.subscriptionEndedAt === null && !isLive(f.subscriptionStatus)) return true;
  if (f.deletionScheduledFor !== null && now.getTime() >= f.deletionScheduledFor.getTime()) return true;
  if (ctx.deletionAbortedSinceLastCheck) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Daily lifecycle actions (§4.4) — evaluated on reconciled facts
// ---------------------------------------------------------------------------

export interface NoticeToEnqueue {
  kind: NoticeKind;
  anchor: Date;
}

export type LifecycleAlert =
  | { kind: 'missing-trial-date' }
  | { kind: 'blocked-transition'; notice: NoticeKind; anchor: Date }
  | { kind: 'undeliverable-trial-reminder'; anchor: Date };

export interface LifecycleActions {
  enqueue: NoticeToEnqueue[];
  /** Set `deletion_scheduled_for` (already passed through the deletion-date rule). */
  setDeletionScheduledFor?: Date;
  /** status='suspended', suspended_at=now, suspension_reason='nonpayment' (guarded: status='active'). */
  suspend?: true;
  /** D9 termination (guarded: status='suspended', reason='nonpayment'). */
  terminate?: true;
  /** Past D with a contractual notice for the current anchor → founder digest (D4: never auto-delete). */
  readyForDeletion?: true;
  alerts: LifecycleAlert[];
}

export interface LifecycleRunContext {
  /** Any open invoice has a payment in flight (ACH processing, or microdeposits within their window). */
  paymentProcessing: boolean;
}

const BLOCKED_AFTER_DAYS = 2;

export function nextLifecycleActions(
  f: LifecycleFacts,
  notices: NoticeState[],
  ctx: LifecycleRunContext,
  now: Date,
): LifecycleActions {
  const actions: LifecycleActions = { enqueue: [], alerts: [] };
  const t = now.getTime();
  const subscribed = hasSubscribed(f);

  // Undeliverable trial reminders (F4 — the trial still ends on schedule): a reminder for the current T was
  // superseded unsent and NO reminder for T was ever given. Not for exempt workspaces (they get no lifecycle mail).
  const T0 = f.trialEndsAt;
  const anyReminderGiven = T0 !== null
    && (noticeGivenAt(notices, 'trial-reminder-7d', T0) !== null || noticeGivenAt(notices, 'trial-reminder-1d', T0) !== null);
  if (!f.lifecycleExempt && !subscribed && !anyReminderGiven) {
    for (const n of notices) {
      if ((n.kind === 'trial-reminder-7d' || n.kind === 'trial-reminder-1d') && n.supersededAt !== null
          && n.sentAt === null && n.forcedAt === null && sameInstant(n.anchor, T0)) {
        actions.alerts.push({ kind: 'undeliverable-trial-reminder', anchor: n.anchor });
        break;
      }
    }
  }

  if (f.status !== 'active' && f.status !== 'suspended') return actions;
  if (f.lifecycleExempt) return actions;

  let D = f.deletionScheduledFor;

  // --- Trial (never subscribed) ---
  if (!subscribed) {
    const T = f.trialEndsAt;
    if (T === null) {
      actions.alerts.push({ kind: 'missing-trial-date' });
    } else if (f.status === 'active') {
      const sevenWindowStart = addDays(T, -Math.max(...TRIAL_REMINDER_DAYS_BEFORE));
      const oneWindowStart = addDays(T, -Math.min(...TRIAL_REMINDER_DAYS_BEFORE));
      if (t >= sevenWindowStart.getTime() && t < oneWindowStart.getTime()) {
        actions.enqueue.push({ kind: 'trial-reminder-7d', anchor: T });
      } else if (t >= oneWindowStart.getTime() && t < T.getTime()) {
        actions.enqueue.push({ kind: 'trial-reminder-1d', anchor: T });
      } else if (t >= T.getTime()) {
        actions.enqueue.push({ kind: 'trial-ended', anchor: T });
        if (D === null) {
          D = deletionDateFrom(addDays(T, POST_END_RETENTION_DAYS), now);
          actions.setDeletionScheduledFor = D;
        }
      }
    }
  }

  // --- Dunning: warning, then suspension (Terms §4.7: after notice) ---
  const P = f.pastDueSince;
  if (f.status === 'active' && P !== null && f.subscriptionEndedAt === null && isDunning(f.subscriptionStatus)) {
    const suspendAt = addDays(P, PAYMENT_GRACE_DAYS);
    const warnAt = addDays(suspendAt, -SUSPENSION_NOTICE_DAYS);
    if (t >= warnAt.getTime()) actions.enqueue.push({ kind: 'suspension-warning', anchor: P });
    const warnedAt = noticeGivenAt(notices, 'suspension-warning', P);
    if (warnedAt !== null) {
      const earliest = maxDate(suspendAt, addDays(warnedAt, SUSPENSION_NOTICE_DAYS));
      if (t >= earliest.getTime() && !ctx.paymentProcessing) actions.suspend = true;
    } else if (t >= suspendAt.getTime()) {
      pushBlocked(actions, notices, 'suspension-warning', P, now);
    }
  }

  // --- Suspended for non-payment: D9 termination after the `suspended` notice ---
  const Sa = f.suspendedAt;
  if (f.status === 'suspended' && f.suspensionReason === 'nonpayment' && Sa !== null) {
    const terminateAt = addDays(Sa, SUSPENDED_DAYS_UNTIL_TERMINATION);
    const suspendedNoticeAt = noticeGivenAt(notices, 'suspended', Sa);
    if (suspendedNoticeAt !== null) {
      if (t >= terminateAt.getTime() && !ctx.paymentProcessing) actions.terminate = true;
    } else if (t >= terminateAt.getTime()) {
      pushBlocked(actions, notices, 'suspended', Sa, now);
    }
  }

  // --- Retention window: deletion notice, push, final reminder, ready ---
  const A = cycleAnchor(f);
  const inWindow = f.subscriptionEndedAt !== null || (!subscribed && f.trialEndsAt !== null && t >= f.trialEndsAt.getTime());
  if (inWindow && A !== null && D !== null) {
    if (t >= addDays(D, -DELETION_NOTICE_DAYS).getTime()) actions.enqueue.push({ kind: 'deletion-notice', anchor: A });
    const noticeAt = noticeGivenAt(notices, 'deletion-notice', A);
    if (noticeAt !== null) {
      const minD = addDays(noticeAt, DELETION_NOTICE_DAYS);
      if (D.getTime() < minD.getTime()) {
        D = minD; // a late delivery never shortens the notice period
        actions.setDeletionScheduledFor = D;
      }
      if (t >= addDays(D, -DELETION_FINAL_REMINDER_DAYS).getTime()) {
        actions.enqueue.push({ kind: 'deletion-final-reminder', anchor: A });
      }
      if (t >= D.getTime() && noticeAt.getTime() <= addDays(D, -DELETION_NOTICE_DAYS).getTime()) {
        actions.readyForDeletion = true;
      }
    } else if (t >= D.getTime()) {
      pushBlocked(actions, notices, 'deletion-notice', A, now);
    }
  }

  return actions;
}

function pushBlocked(actions: LifecycleActions, notices: NoticeState[], kind: NoticeKind, anchor: Date, now: Date): void {
  const row = notices.find((n) => n.kind === kind && sameInstant(n.anchor, anchor) && n.supersededAt === null);
  const since = row?.createdAt ?? now;
  if (now.getTime() - since.getTime() >= BLOCKED_AFTER_DAYS * MS_PER_DAY) {
    actions.alerts.push({ kind: 'blocked-transition', notice: kind, anchor });
  }
}
