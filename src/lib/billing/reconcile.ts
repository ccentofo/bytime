import 'server-only';
import { inArray } from 'drizzle-orm';
import { tenants } from '@/db/control-plane/schema';
import type { ControlTx } from '@/db/control-plane/locked';
import { enqueueNotice } from '@/lib/tenant/notices';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { raiseAlert, resolveAlert, resolveAlertsOfKind, updateTenantGuarded, type TenantRow } from '@/lib/tenant/lifecycle-store';
import { isDunning, isGood, isLive } from '@/lib/tenant/lifecycle';
import { listOpenInvoicesForSubscription, readCustomerSubscriptions, type OpenInvoiceState } from './stripe-state';
import {
  computeInvoiceOverdueSince,
  computeSubscriptionTransition,
  selectTracked,
  type InvoiceFacts,
  type StripeSubSnapshot,
} from './subscription-transitions';

/**
 * §4.3 rule 4 + transition table, applied INSIDE a locked section (`tx` from withTenantLock). Shared by the
 * webhook, the lifecycle cron's reconcile, and deleteTenant step 3, so all three apply identical rules.
 */

type TenantPatch = Parameters<typeof updateTenantGuarded>[2];

export interface ReconcileOutcome {
  row: TenantRow;
  subs: StripeSubSnapshot[];
  tracked: StripeSubSnapshot | null;
  customerDeleted: boolean;
  noticeIds: string[];
  /**
   * feature-plan-per-user-billing.md §6.2/§6.5: the tenant just became good — Stripe moved to GOOD, an invoiced
   * account's overdue anchor cleared while the subscription is LIVE, or an ended tenant was revived. Callers mark the
   * seat sync due on it.
   */
  becameGood: boolean;
}

export async function reconcileInLock(tx: ControlTx, row: TenantRow, now: Date, opts: {
  /** Customer to read (defaults to the row's); checkout passes the customer it is about to link. */
  customerId?: string;
  /** The event itself proves the customer is deleted (customer.deleted). */
  knownCustomerDeleted?: boolean;
  /** Extra non-transition fields written in the same guarded update (checkout customer link, billing email). */
  extraPatch?: TenantPatch;
  /** deleteTenant only: reconcile writes are allowed while status='deleting' (§5.3 step 3 exception). */
  allowDeleting?: boolean;
  /**
   * feature-plan-per-user-billing.md §6.2 (lead ruling B3): a LAZY loader of the customer's open invoices, called only
   * for a send_invoice subscription, with the `customerDeleted` flag this reconcile learned. The lifecycle runner
   * passes a memoized loader and reuses its result, so the locked section still lists invoices once. Without it (the
   * webhook), one per-subscription list is made.
   */
  loadOpenInvoices?: (customerDeleted: boolean) => Promise<OpenInvoiceState[]>;
} = {}): Promise<ReconcileOutcome> {
  const customerId = opts.customerId ?? row.stripeCustomerId;
  const extra = opts.extraPatch ?? {};
  if (!customerId) {
    const updated = Object.keys(extra).length > 0 ? await updateTenantGuarded(tx, row, extra, now) : row;
    return { row: updated, subs: [], tracked: null, customerDeleted: false, noticeIds: [], becameGood: false };
  }

  const knownDeleted = opts.knownCustomerDeleted === true
    || (customerId === row.stripeCustomerId && row.stripeCustomerDeletedAt !== null);
  const { subs, customerDeleted } = await readCustomerSubscriptions(customerId, row.stripeSubscriptionId, knownDeleted);
  const { tracked, duplicateLive } = selectTracked(subs, row.stripeSubscriptionId);

  // §6.2 invoice facts: only for a tracked send_invoice subscription that is GOOD or DUNNING (never for canceled,
  // incomplete or paused). Computed on every such reconcile, ended tenants included; skipped under allowDeleting.
  let invoiceFacts: InvoiceFacts = { kind: 'charge' };
  if (tracked && tracked.collectionMethod === 'send_invoice' && (isGood(tracked.status) || isDunning(tracked.status))) {
    if (opts.allowDeleting) {
      invoiceFacts = { kind: 'skipped' };
    } else {
      const invoices = opts.loadOpenInvoices
        ? await opts.loadOpenInvoices(customerDeleted)
        : await listOpenInvoicesForSubscription(tracked.id, customerId, customerDeleted);
      invoiceFacts = {
        kind: 'invoiced',
        overdueSince: computeInvoiceOverdueSince(invoices, tracked.id, row.pastDueSince, row.subscriptionEndedAt, now),
      };
    }
  }

  const result = computeSubscriptionTransition(toLifecycleFacts(row), tracked, subs, duplicateLive, now, invoiceFacts);

  const patch: TenantPatch = { ...result.patch, ...extra };
  // §6.2: an Enterprise workspace stays Enterprise until the founder's `set-plan standard`.
  if (row.plan === 'enterprise') {
    delete patch.plan;
    delete patch.planInterval;
  }
  if (customerDeleted && row.stripeCustomerDeletedAt === null && customerId === row.stripeCustomerId) {
    patch.stripeCustomerDeletedAt = now; // the id itself is never nulled
  }

  let updated = row;
  if (Object.keys(patch).length > 0) {
    const statuses: TenantRow['status'][] = opts.allowDeleting ? ['active', 'suspended', 'deleting'] : ['active', 'suspended'];
    updated = await updateTenantGuarded(tx, row, patch, now, inArray(tenants.status, statuses));
  }

  // Notices only after the guarded UPDATE returned a row, in the same transaction (§4.1).
  const noticeIds: string[] = [];
  for (const n of result.notices) {
    const id = await enqueueNotice(tx, row.id, n.kind, n.anchor);
    if (id) noticeIds.push(id);
  }
  for (const a of result.alerts) {
    await raiseAlert(tx, { tenantId: row.id, kind: a.kind, dedupKey: a.dedupKey, detail: a.detail }, now);
  }
  if (!duplicateLive) await resolveAlert(tx, { tenantId: row.id, kind: 'duplicate-live-subscriptions' }, now);
  // §6.2: the mirror now agrees with Stripe's status, so any drift alert the seat sync raised is resolved.
  if (result.patch.subscriptionStatus !== undefined) {
    await resolveAlertsOfKind(tx, row.id, 'subscription-status-drift', now);
  }

  const live = isLive(updated.subscriptionStatus);
  const becameGood = (!isGood(row.subscriptionStatus) && isGood(updated.subscriptionStatus))
    || (live && row.pastDueSince !== null && updated.pastDueSince === null)
    || (live && row.subscriptionEndedAt !== null && updated.subscriptionEndedAt === null);

  return { row: updated, subs, tracked, customerDeleted, noticeIds, becameGood };
}
