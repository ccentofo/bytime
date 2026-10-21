/**
 * Tenant lifecycle: access mode derivation and the daily cron's "what's due" computation.
 *
 * Both functions here are PURE — no DB, no clock reads, no I/O. `now` is always an explicit
 * parameter so tests can inject any instant. Callers (src/lib/tenant/context.ts,
 * src/app/api/cron/tenant-lifecycle/route.ts) own reading the tenant row and the real clock, and
 * applying whatever these functions say is due.
 *
 * feature-plan-terms-compliance.md §3.1, §3.2, T2.
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

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Access mode
// ---------------------------------------------------------------------------

export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted';

/** The subset of the `tenants` row that access-mode/lifecycle decisions need. */
export interface LifecycleTenant {
  status: TenantStatus;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  suspendedAt: Date | null;
  subscriptionEndedAt: Date | null;
  deletionScheduledFor: Date | null;
}

export type TenantAccessMode = 'full' | 'read_only' | 'billing_only' | 'closed';

function hasActiveSubscription(tenant: Pick<LifecycleTenant, 'subscriptionStatus'>): boolean {
  return tenant.subscriptionStatus === 'active' || tenant.subscriptionStatus === 'trialing';
}

/**
 * §3.1: one pure function decides the access mode from the tenant's stored FACTS and the clock.
 * Never the other way around — nothing here mutates or infers a fact, it only reads them.
 *
 * Precedence (checked in order):
 * 1. `deleting` / `deleted` status, or past `deletion_scheduled_for` (even if the actual deletion
 *    hasn't run yet — D4 deletion is founder-run, so there's a real gap here) → `closed`.
 * 2. `suspended` status (non-payment; see `nextLifecycleActions` for when the cron sets this) →
 *    `billing_only`.
 * 3. An active/trialing Stripe subscription → `full`, regardless of `trial_ends_at` (a converted
 *    trial customer's old trial date is irrelevant forever after).
 * 4. No subscription yet and the trial hasn't ended (or `trial_ends_at` is unset, e.g. a tenant
 *    provisioned before T4 and not yet backfilled) → `full`.
 * 5. Trial ended with no subscription → `read_only` (R2).
 * 6. A subscription existed and ended, and we're still inside the post-end retention window
 *    (`deletion_scheduled_for` not yet reached — case 1 already handled "reached") → `read_only`
 *    (R9/D6).
 * 7. Anything else (active status, no trial/subscription signal at all) → `full`: an `active`
 *    tenant with no restrictive fact set should work normally, not be penalized for a fact that
 *    was never populated (e.g. provisioning raced ahead of the trial_ends_at write).
 */
export function getTenantAccess(tenant: LifecycleTenant, now: Date): TenantAccessMode {
  if (
    tenant.status === 'deleting' ||
    tenant.status === 'deleted' ||
    tenant.status === 'provisioning' ||
    (tenant.deletionScheduledFor !== null && now >= tenant.deletionScheduledFor)
  ) {
    return 'closed';
  }

  if (tenant.status === 'suspended') {
    return 'billing_only';
  }

  if (hasActiveSubscription(tenant)) {
    return 'full';
  }

  if (tenant.trialEndsAt === null || now < tenant.trialEndsAt) {
    return 'full';
  }

  // Trial has ended (trialEndsAt !== null && now >= trialEndsAt) and there's no active
  // subscription — R2, or R9 if a subscription existed and later ended. Either way: read_only.
  // (subscriptionEndedAt is also read_only via the same branch — both cases already passed the
  // "past deletion_scheduled_for" closed-check above, so they're still within the window.)
  return 'read_only';
}

// ---------------------------------------------------------------------------
// Daily lifecycle actions (cron)
// ---------------------------------------------------------------------------

export interface NoticeDue {
  kind: string;
  /** The logical deadline this notice is FOR — the idempotency key's third column. */
  scheduledFor: Date;
}

export interface LifecycleActions {
  /** Notices to send this run, via `sendTenantNotice` (which itself dedupes on kind+scheduledFor). */
  noticesDue: NoticeDue[];
  /** Trial ended unpurchased: set `deletion_scheduled_for` to this instant (only when unset). */
  setDeletionScheduledFor?: Date;
  /** Payment grace period elapsed: set status='suspended', suspended_at=now (only when not already suspended). */
  suspend?: boolean;
  /**
   * D9: suspended long enough to terminate. The caller must cancel the Stripe subscription, set
   * `subscription_ended_at = now`, `deletion_scheduled_for = now + POST_END_RETENTION_DAYS`,
   * `status = 'active'` (D9: "follows the normal subscription-ended path"), and send the
   * `subscription-ended` notice itself — this flag only signals that it's due, synchronously, not
   * via waiting for the resulting Stripe webhook (see T5's idempotency note).
   */
  terminateSubscription?: boolean;
  /** Past `deletion_scheduled_for` and not yet `deleting`/`deleted` — flag for the founder digest. */
  readyForDeletion?: boolean;
}

/**
 * §3.3/T4: pure "what's due today" computation for the daily lifecycle cron. Every branch is
 * idempotent to call repeatedly (safe to run the cron twice the same day, or every day after a
 * threshold without the caller tracking what it already did) — actual de-duplication of SENDS
 * happens in `sendTenantNotice`'s unique constraint; de-duplication of STATE CHANGES happens
 * because the caller only applies `setDeletionScheduledFor`/`suspend`/`terminateSubscription` when
 * the corresponding field isn't already set (each flag's doc comment says which field to check).
 */
export function nextLifecycleActions(tenant: LifecycleTenant, now: Date): LifecycleActions {
  const notices: NoticeDue[] = [];
  let setDeletionScheduledFor: Date | undefined;
  let suspend = false;
  let terminateSubscription = false;
  let readyForDeletion = false;

  // --- Trial reminders, trial-ended, and scheduling deletion when the trial lapses ---
  if (tenant.status === 'active' && tenant.trialEndsAt !== null && !hasActiveSubscription(tenant)) {
    const trialEndsAt = tenant.trialEndsAt;
    for (const daysBefore of TRIAL_REMINDER_DAYS_BEFORE) {
      const triggerAt = addDays(trialEndsAt, -daysBefore);
      if (now >= triggerAt && now < trialEndsAt) {
        notices.push({ kind: `trial-reminder-${daysBefore}d`, scheduledFor: trialEndsAt });
      }
    }
    if (now >= trialEndsAt) {
      notices.push({ kind: 'trial-ended', scheduledFor: trialEndsAt });
      if (tenant.deletionScheduledFor === null) {
        setDeletionScheduledFor = addDays(trialEndsAt, POST_END_RETENTION_DAYS);
      }
    }
  }

  // --- Payment grace: suspension-warning, then suspend (invoice.payment_failed's own
  //     `payment-failed` notice is sent directly by the webhook at the moment it happens — T5 —
  //     not recomputed here, since it's a one-time event, not a recurring deadline check). ---
  if (tenant.status === 'active' && tenant.pastDueSince !== null) {
    const suspendAt = addDays(tenant.pastDueSince, PAYMENT_GRACE_DAYS);
    const warnAt = addDays(suspendAt, -SUSPENSION_NOTICE_DAYS);
    if (now >= warnAt && now < suspendAt) {
      notices.push({ kind: 'suspension-warning', scheduledFor: suspendAt });
    }
    if (now >= suspendAt) {
      suspend = true;
      notices.push({ kind: 'suspended', scheduledFor: suspendAt });
    }
  }

  // --- D9: terminate a long-suspended, still-unpaid workspace ---
  if (tenant.status === 'suspended' && tenant.suspendedAt !== null && tenant.subscriptionEndedAt === null) {
    const terminateAt = addDays(tenant.suspendedAt, SUSPENDED_DAYS_UNTIL_TERMINATION);
    if (now >= terminateAt) {
      terminateSubscription = true;
    }
  }

  // --- Deletion notices and the founder-digest "ready" flag ---
  if (
    (tenant.status === 'active' || tenant.status === 'suspended') &&
    tenant.deletionScheduledFor !== null
  ) {
    const deletionScheduledFor = tenant.deletionScheduledFor;
    const noticeAt = addDays(deletionScheduledFor, -DELETION_NOTICE_DAYS);
    const finalAt = addDays(deletionScheduledFor, -DELETION_FINAL_REMINDER_DAYS);
    if (now >= noticeAt) {
      notices.push({ kind: 'deletion-notice', scheduledFor: deletionScheduledFor });
    }
    if (now >= finalAt) {
      notices.push({ kind: 'deletion-final-reminder', scheduledFor: deletionScheduledFor });
    }
    if (now >= deletionScheduledFor) {
      readyForDeletion = true;
    }
  }

  return { noticesDue: notices, setDeletionScheduledFor, suspend, terminateSubscription, readyForDeletion };
}
