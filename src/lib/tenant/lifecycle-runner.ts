import 'server-only';
import { and, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { opsAlerts, paymentPendingObservations, tenantAuditEvents, tenantNotices, tenants } from '@/db/control-plane/schema';
import {
  LifecycleVersionConflictError,
  TenantLockTimeoutError,
  withLockedPool,
  withTenantLock,
  type ControlTx,
} from '@/db/control-plane/locked';
import { reconcileInLock } from '@/lib/billing/reconcile';
import {
  cancelSubscriptionIdempotent,
  closeOpenInvoice,
  isInvoiceOpen,
  readOpenInvoices,
  retrieveSubscription,
  type OpenInvoiceState,
} from '@/lib/billing/stripe-state';
import type { StripeSubSnapshot } from '@/lib/billing/subscription-transitions';
import {
  addDays,
  deletionDateFrom,
  isDunning,
  isGood,
  nextLifecycleActions,
  shouldReconcile,
  type NoticeKind,
} from './lifecycle';
import { DELETION_SLA_DAYS, POST_END_RETENTION_DAYS } from './lifecycle-config';
import { deliverNotice, enqueueNotice } from './notices';
import { isEmailEnabled } from '@/lib/email/client';
import { invalidateTenant, toLifecycleFacts } from './registry';
import { raiseAlert, readTenant, resolveAlert, updateTenantGuarded, type TenantRow } from './lifecycle-store';

/**
 * One tenant's daily lifecycle run (feature-plan-terms-compliance-fixes.md §4.4): reconcile with Stripe when the
 * mirror may be stale, evaluate the pure rules, apply them under the tenant lock with the version guard, then —
 * outside that transaction — payment observations, per-subscription cancels, invoice voids, notice delivery and
 * the failure counter.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MICRODEPOSIT_WINDOW_DAYS = 10;
const PENDING_PAYMENT_ALERT_DAYS = 10;
const UNDELIVERABLE_AFTER_DAYS = 2;
const FAILING_ALERT_THRESHOLD = 3;
/** Alert kinds derived from this run's evaluation; resolved automatically once no longer reported. */
const CONDITION_ALERT_KINDS = ['missing-trial-date', 'blocked-transition', 'undeliverable-trial-reminder', 'undeliverable-notice'];

type Observation = typeof paymentPendingObservations.$inferSelect;

export interface TenantRunResult {
  slug: string;
  outcome: 'ok' | 'failed' | 'lock-timeout' | 'not-applicable';
  error?: string;
  reconciled?: boolean;
  suspended?: boolean;
  terminated?: boolean;
  readyForDeletion?: { deletionScheduledFor: Date; overdue: boolean };
  blockedDeletion?: string;
  noticesEnqueued: number;
  noticesSent: number;
}

interface InLockResult {
  row: TenantRow;
  reconciled: boolean;
  invoices: OpenInvoiceState[] | null;
  noticeIds: string[];
  toCancel: string[];
  suspended: boolean;
  terminated: boolean;
  readyForDeletion?: { deletionScheduledFor: Date; overdue: boolean };
  blockedDeletion?: string;
}

function observedSince(obs: Observation[], invoiceId: string, kind: 'processing' | 'microdeposit', now: Date): Date {
  return obs.find((o) => o.invoiceId === invoiceId && o.kind === kind)?.firstSeenAt ?? now; // none yet = now (defers; safe)
}

/** Payment in flight: ACH processing, or microdeposit verification within its cumulative 10-day window. */
export function hasPaymentProcessing(invoices: OpenInvoiceState[], obs: Observation[], now: Date): boolean {
  return invoices.some((i) => i.processing
    || (i.microdeposit && now.getTime() - observedSince(obs, i.invoiceId, 'microdeposit', now).getTime() < MICRODEPOSIT_WINDOW_DAYS * MS_PER_DAY));
}

export async function runTenantLifecycle(tenantId: string, now: Date = new Date()): Promise<TenantRunResult> {
  const pre = await withLockedPool(async (db) => {
    const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!row) return null;
    const obs = await db.select().from(paymentPendingObservations).where(eq(paymentPendingObservations.tenantId, tenantId));
    const [aborted] = await db.select({ id: tenantAuditEvents.id }).from(tenantAuditEvents).where(and(
      eq(tenantAuditEvents.tenantId, tenantId),
      eq(tenantAuditEvents.kind, 'deletion-aborted'),
      row.lifecycleCheckedAt ? gt(tenantAuditEvents.createdAt, row.lifecycleCheckedAt) : undefined,
    )).limit(1);
    return { row, obs, deletionAborted: Boolean(aborted) };
  });
  if (!pre) return { slug: '?', outcome: 'not-applicable', noticesEnqueued: 0, noticesSent: 0 };

  const result: TenantRunResult = { slug: pre.row.slug, outcome: 'ok', noticesEnqueued: 0, noticesSent: 0 };
  let failed = false;
  const noticeIds: string[] = [];
  let inLock: InLockResult | null = null;

  try {
    inLock = await withTenantLock(tenantId, (tx) => evaluateInLock(tx, tenantId, pre.obs, pre.deletionAborted, now));
  } catch (err) {
    failed = true;
    result.outcome = err instanceof TenantLockTimeoutError ? 'lock-timeout' : 'failed';
    result.error = err instanceof Error ? err.message : String(err);
    if (err instanceof LifecycleVersionConflictError) {
      await withLockedPool((db) => raiseAlert(db, { tenantId, kind: 'lifecycle-version-conflict' }, now)).catch(() => {});
    }
    if (!(err instanceof TenantLockTimeoutError)) console.error(`[tenant-lifecycle] ${pre.row.slug} failed:`, err);
  }

  if (inLock) {
    result.reconciled = inLock.reconciled;
    result.suspended = inLock.suspended;
    result.terminated = inLock.terminated;
    result.readyForDeletion = inLock.readyForDeletion;
    result.blockedDeletion = inLock.blockedDeletion;
    noticeIds.push(...inLock.noticeIds);
    invalidateTenant(inLock.row.slug);

    // Observations: their own statements after the tenant transaction (a rollback can't drop them).
    try {
      await writeObservations(tenantId, pre.obs, inLock.invoices, now);
    } catch (err) {
      failed = true;
      console.error(`[tenant-lifecycle] ${pre.row.slug} observations failed:`, err);
    }

    // Termination / ended-but-still-LIVE: each subscription in its own locked section.
    for (const subId of inLock.toCancel) {
      const ok = await cancelInOwnSection(tenantId, subId, pre.obs, now, noticeIds);
      if (!ok) failed = true;
    }
  }

  // Retry every unresolved invoice void for this tenant (resolved only when no open invoice remains).
  try {
    await retryPendingVoids(tenantId, now);
  } catch (err) {
    failed = true;
    console.error(`[tenant-lifecycle] ${pre.row.slug} invoice void retry failed:`, err);
  }

  result.noticesEnqueued = noticeIds.length;
  for (const id of noticeIds) {
    try {
      if ((await deliverNotice(id, now)) === 'sent') result.noticesSent++;
    } catch (err) {
      console.error(`[tenant-lifecycle] notice ${id} left for the delivery cron:`, err);
    }
  }

  if (failed && result.outcome === 'ok') result.outcome = 'failed';
  await recordCheck(tenantId, failed, now);
  return result;
}

async function evaluateInLock(
  tx: ControlTx,
  tenantId: string,
  obs: Observation[],
  deletionAborted: boolean,
  now: Date,
): Promise<InLockResult | null> {
  let row = await readTenant(tx, tenantId);
  if (!row || (row.status !== 'active' && row.status !== 'suspended')) return null;

  const reconciled = shouldReconcile(toLifecycleFacts(row), {
    hasStripeCustomer: row.stripeCustomerId !== null,
    stripeCustomerDeleted: row.stripeCustomerDeletedAt !== null,
    currentPeriodEnd: row.currentPeriodEnd,
    deletionAbortedSinceLastCheck: deletionAborted,
  }, now);

  const noticeIds: string[] = [];
  let subs: StripeSubSnapshot[] = [];
  let invoices: OpenInvoiceState[] | null = null;
  if (reconciled) {
    const r = await reconcileInLock(tx, row, now);
    row = r.row;
    subs = r.subs;
    noticeIds.push(...r.noticeIds);
    // Always listed when reconciling (paginated); resource_missing = empty only for a confirmed-deleted customer.
    invoices = await readOpenInvoices(row.stripeCustomerId!, row.stripeCustomerDeletedAt !== null || r.customerDeleted);
  }
  const paymentProcessing = invoices !== null && hasPaymentProcessing(invoices, obs, now);

  const noticeRows = await tx.select().from(tenantNotices).where(eq(tenantNotices.tenantId, row.id));
  const actions = nextLifecycleActions(toLifecycleFacts(row), noticeRows.map((n) => ({
    kind: n.kind, anchor: n.scheduledFor, sentAt: n.sentAt, forcedAt: n.forcedAt, supersededAt: n.supersededAt, createdAt: n.createdAt,
  })), { paymentProcessing }, now);

  const patch: Parameters<typeof updateTenantGuarded>[2] = {};
  let guard: SQL = inArray(tenants.status, ['active', 'suspended']);
  const enqueue: Array<{ kind: NoticeKind; anchor: Date }> = [...actions.enqueue];
  if (actions.setDeletionScheduledFor) patch.deletionScheduledFor = actions.setDeletionScheduledFor;
  if (actions.suspend) {
    Object.assign(patch, { status: 'suspended', suspendedAt: now, suspensionReason: 'nonpayment' });
    guard = eq(tenants.status, 'active'); // never re-suspends, never overwrites a policy reason
    enqueue.push({ kind: 'suspended', anchor: now });
  }
  if (actions.terminate) {
    Object.assign(patch, {
      subscriptionEndedAt: now,
      deletionScheduledFor: deletionDateFrom(addDays(now, POST_END_RETENTION_DAYS), now),
      pastDueSince: null, suspendedAt: null, suspensionReason: null, status: 'active',
    });
    guard = and(eq(tenants.status, 'suspended'), eq(tenants.suspensionReason, 'nonpayment'))!;
    enqueue.push({ kind: 'subscription-ended', anchor: now });
  }
  if (Object.keys(patch).length > 0) row = await updateTenantGuarded(tx, row, patch, now, guard);

  for (const n of enqueue) {
    const id = await enqueueNotice(tx, row.id, n.kind, n.anchor);
    if (id) noticeIds.push(id);
  }

  // Condition alerts: raise what this run reports, resolve what it no longer reports.
  const reported = new Set<string>();
  const report = async (kind: string, dedupKey: string, detail?: Record<string, unknown>) => {
    reported.add(`${kind}|${dedupKey}`);
    await raiseAlert(tx, { tenantId: row!.id, kind, dedupKey, detail }, now);
  };
  for (const a of actions.alerts) {
    if (a.kind === 'missing-trial-date') await report(a.kind, '');
    else if (a.kind === 'blocked-transition') await report(a.kind, `${a.notice}:${a.anchor.toISOString()}`);
    else await report(a.kind, a.anchor.toISOString());
  }
  for (const n of noticeRows) {
    const pending = n.sentAt === null && n.forcedAt === null && n.supersededAt === null;
    if (pending && now.getTime() - n.createdAt.getTime() >= UNDELIVERABLE_AFTER_DAYS * MS_PER_DAY) {
      await report('undeliverable-notice', n.id, { kind: n.kind, lastError: n.lastError });
    }
  }
  const open = await tx.select({ kind: opsAlerts.kind, dedupKey: opsAlerts.dedupKey }).from(opsAlerts)
    .where(and(eq(opsAlerts.scope, row.id), inArray(opsAlerts.kind, CONDITION_ALERT_KINDS), isNull(opsAlerts.resolvedAt)));
  for (const a of open) {
    if (!reported.has(`${a.kind}|${a.dedupKey}`)) await resolveAlert(tx, { tenantId: row.id, kind: a.kind, dedupKey: a.dedupKey }, now);
  }

  // Ended (incl. just terminated) with Stripe still LIVE: cancel each DUNNING/paused one in its own section.
  const toCancel = row.subscriptionEndedAt !== null
    ? subs.filter((s) => isDunning(s.status) || s.status === 'paused').map((s) => s.id)
    : [];

  let readyForDeletion: InLockResult['readyForDeletion'];
  let blockedDeletion: string | undefined;
  if (actions.readyForDeletion && row.deletionScheduledFor) {
    if (subs.some((s) => isGood(s.status) || s.status === 'incomplete') || paymentProcessing) {
      blockedDeletion = 'payment activity';
    } else {
      const D = row.deletionScheduledFor;
      readyForDeletion = { deletionScheduledFor: D, overdue: now.getTime() - D.getTime() > DELETION_SLA_DAYS * MS_PER_DAY };
    }
  }

  return {
    row, reconciled, invoices, noticeIds, toCancel,
    suspended: Boolean(actions.suspend), terminated: Boolean(actions.terminate),
    readyForDeletion, blockedDeletion,
  };
}

/**
 * payment_pending_observations (§4.4): insert-if-absent on first sight; delete only after a complete listing
 * shows the invoice is no longer open; a `processing` row is dropped once its PaymentIntent stops processing.
 * Without a fresh listing, rows older than 10 days are re-checked individually.
 */
async function writeObservations(tenantId: string, obs: Observation[], invoices: OpenInvoiceState[] | null, now: Date): Promise<void> {
  const T = paymentPendingObservations;
  await withLockedPool(async (db) => {
    let stillProcessingStale = false;
    if (invoices !== null) {
      const openIds = new Set(invoices.map((i) => i.invoiceId));
      for (const i of invoices) {
        if (i.processing) {
          await db.insert(T).values({ tenantId, invoiceId: i.invoiceId, kind: 'processing', firstSeenAt: now }).onConflictDoNothing();
          const since = observedSince(obs, i.invoiceId, 'processing', now);
          if (now.getTime() - since.getTime() > PENDING_PAYMENT_ALERT_DAYS * MS_PER_DAY) stillProcessingStale = true;
        } else {
          await db.delete(T).where(and(eq(T.tenantId, tenantId), eq(T.invoiceId, i.invoiceId), eq(T.kind, 'processing')));
        }
        if (i.microdeposit) {
          await db.insert(T).values({ tenantId, invoiceId: i.invoiceId, kind: 'microdeposit', firstSeenAt: now }).onConflictDoNothing();
        }
      }
      for (const o of obs) {
        if (!openIds.has(o.invoiceId)) await db.delete(T).where(and(eq(T.tenantId, tenantId), eq(T.invoiceId, o.invoiceId)));
      }
    } else {
      for (const o of obs) {
        if (now.getTime() - o.firstSeenAt.getTime() <= MICRODEPOSIT_WINDOW_DAYS * MS_PER_DAY) continue;
        if (!(await isInvoiceOpen(o.invoiceId))) {
          await db.delete(T).where(and(eq(T.tenantId, tenantId), eq(T.invoiceId, o.invoiceId)));
        } else if (o.kind === 'processing') {
          stillProcessingStale = true; // unknown whether still processing without a listing: keep the alert
        }
      }
    }
    if (stillProcessingStale) {
      await raiseAlert(db, { tenantId, kind: 'pending-payment' }, now);
    } else {
      await resolveAlert(db, { tenantId, kind: 'pending-payment' }, now);
    }
  });
}

/**
 * Cancel one subscription of an ended tenant, in its own locked section: re-read the row (must still be ended),
 * retrieve the subscription; GOOD → apply the GOOD transition (customer paid); DUNNING/paused with no payment in
 * flight → cancel. Voiding its open invoices happens after commit (idempotent, tracked by an alert).
 */
async function cancelInOwnSection(tenantId: string, subId: string, obs: Observation[], now: Date, noticeIds: string[]): Promise<boolean> {
  try {
    const action = await withTenantLock(tenantId, async (tx): Promise<'void' | 'skip'> => {
      const row = await readTenant(tx, tenantId);
      if (!row || row.subscriptionEndedAt === null || !row.stripeCustomerId) return 'skip';
      if (row.status !== 'active' && row.status !== 'suspended') return 'skip';
      const sub = await retrieveSubscription(subId);
      if (!sub || sub.status === 'canceled' || sub.status === 'incomplete_expired') return 'void';
      if (isGood(sub.status)) {
        const r = await reconcileInLock(tx, row, now);
        noticeIds.push(...r.noticeIds);
        return 'skip';
      }
      if (!isDunning(sub.status) && sub.status !== 'paused') return 'skip';
      const invoices = (await readOpenInvoices(row.stripeCustomerId, row.stripeCustomerDeletedAt !== null))
        .filter((i) => i.subscriptionId === subId);
      if (hasPaymentProcessing(invoices, obs, now)) return 'skip'; // re-checked next run
      await cancelSubscriptionIdempotent(subId);
      return 'void';
    });
    await withLockedPool((db) => resolveAlert(db, { tenantId, kind: 'stripe-cancel-failure', dedupKey: subId }, now));
    if (action === 'void') {
      await withLockedPool((db) => raiseAlert(db, { tenantId, kind: 'pending-invoice-void', dedupKey: subId, detail: { subscription: subId } }, now));
      try {
        await voidSubscriptionInvoices(tenantId, subId, now);
      } catch (err) {
        // The cancel succeeded; the open pending-invoice-void alert is retried every run (retryPendingVoids).
        console.error(`[tenant-lifecycle] void after cancel of ${subId} failed (will retry):`, err);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error(`[tenant-lifecycle] cancel ${subId} failed:`, err);
    await withLockedPool((db) => raiseAlert(db, { tenantId, kind: 'stripe-cancel-failure', dedupKey: subId, detail: { error: String(err) } }, now)).catch(() => {});
    return false;
  }
}

/** Void (or mark uncollectible) every open invoice of a cancelled subscription; resolve the alert when none remain. */
export async function voidSubscriptionInvoices(tenantId: string, subId: string, now: Date): Promise<void> {
  const [row] = await withLockedPool((db) => db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1));
  if (!row?.stripeCustomerId) return;
  const deleted = row.stripeCustomerDeletedAt !== null;
  const open = (await readOpenInvoices(row.stripeCustomerId, deleted)).filter((i) => i.subscriptionId === subId);
  for (const inv of open) await closeOpenInvoice(inv.invoiceId);
  const remaining = (await readOpenInvoices(row.stripeCustomerId, deleted)).filter((i) => i.subscriptionId === subId);
  if (remaining.length === 0) {
    await withLockedPool((db) => resolveAlert(db, { tenantId, kind: 'pending-invoice-void', dedupKey: subId }, now));
  }
}

async function retryPendingVoids(tenantId: string, now: Date): Promise<void> {
  const pending = await withLockedPool((db) => db.select({ dedupKey: opsAlerts.dedupKey }).from(opsAlerts)
    .where(and(eq(opsAlerts.scope, tenantId), eq(opsAlerts.kind, 'pending-invoice-void'), isNull(opsAlerts.resolvedAt))));
  for (const p of pending) await voidSubscriptionInvoices(tenantId, p.dedupKey, now);
}

/** One separate statement after the tenant's transaction: rotation timestamp and the failure counter + alert. */
async function recordCheck(tenantId: string, failed: boolean, now: Date): Promise<void> {
  await withLockedPool(async (db) => {
    const [r] = await db.update(tenants)
      .set({ lifecycleCheckedAt: now, lifecycleFailures: failed ? sql`${tenants.lifecycleFailures} + 1` : 0 })
      .where(eq(tenants.id, tenantId))
      .returning({ failures: tenants.lifecycleFailures });
    if (!r) return;
    if (r.failures >= FAILING_ALERT_THRESHOLD) {
      await raiseAlert(db, { tenantId, kind: 'tenant-lifecycle-failing', detail: { consecutiveFailures: r.failures } }, now);
    } else if (r.failures === 0) {
      await resolveAlert(db, { tenantId, kind: 'tenant-lifecycle-failing' }, now);
    }
  });
}

export interface LifecycleCronSummary {
  results: TenantRunResult[];
  candidates: number;
  incomplete: boolean;
}

/**
 * The daily run over every active/suspended tenant, oldest-checked first, stopping new tenants after `budgetMs`
 * so a slow run (or a tenant that always fails) can't starve the rest. `onlyTenantIds` restricts the run (tests).
 */
export async function runLifecycleCron(opts: {
  budgetMs: number;
  onlyTenantIds?: string[];
  now?: () => Date;
  /** Raise the email-disabled alert when email is off (default: in production, which includes staging). */
  requireEmail?: boolean;
}): Promise<LifecycleCronSummary> {
  const started = Date.now();
  const clock = opts.now ?? (() => new Date());

  // Notices can't go out without email: surface it every run (one deduplicated alert, resolved when fixed).
  const requireEmail = opts.requireEmail ?? process.env.NODE_ENV === 'production';
  const emailNow = clock();
  if (requireEmail && !isEmailEnabled()) {
    console.warn('[tenant-lifecycle] RESEND_API_KEY is not set — lifecycle notices cannot be delivered.');
    await withLockedPool((db) => raiseAlert(db, { tenantId: null, kind: 'email-disabled' }, emailNow));
  } else {
    await withLockedPool((db) => resolveAlert(db, { tenantId: null, kind: 'email-disabled' }, emailNow));
  }
  const candidates = await withLockedPool((db) => db.select({ id: tenants.id }).from(tenants)
    .where(and(
      inArray(tenants.status, ['active', 'suspended']),
      opts.onlyTenantIds ? inArray(tenants.id, opts.onlyTenantIds.length ? opts.onlyTenantIds : ['00000000-0000-0000-0000-000000000000']) : undefined,
    ))
    .orderBy(sql`${tenants.lifecycleCheckedAt} asc nulls first`, tenants.createdAt));

  const results: TenantRunResult[] = [];
  let incomplete = false;
  let attempted = 0;
  for (const { id } of candidates) {
    // Always make progress: at least one tenant per run, even if setup ate the budget.
    if (attempted > 0 && Date.now() - started > opts.budgetMs) {
      incomplete = true;
      break;
    }
    attempted++;
    try {
      results.push(await runTenantLifecycle(id, clock()));
    } catch (err) {
      // runTenantLifecycle handles its own failures; last-resort guard so one tenant can't end the run.
      console.error(`[tenant-lifecycle] tenant ${id} crashed:`, err);
    }
  }

  const doneAt = clock();
  await withLockedPool(async (db) => {
    if (incomplete) await raiseAlert(db, { tenantId: null, kind: 'cron-incomplete-run', detail: { processed: results.length, candidates: candidates.length } }, doneAt);
    else await resolveAlert(db, { tenantId: null, kind: 'cron-incomplete-run' }, doneAt);
  });
  return { results, candidates: candidates.length, incomplete };
}
