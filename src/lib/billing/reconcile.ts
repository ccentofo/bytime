import 'server-only';
import { inArray } from 'drizzle-orm';
import { tenants } from '@/db/control-plane/schema';
import type { ControlTx } from '@/db/control-plane/locked';
import { enqueueNotice } from '@/lib/tenant/notices';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { raiseAlert, resolveAlert, updateTenantGuarded, type TenantRow } from '@/lib/tenant/lifecycle-store';
import { readCustomerSubscriptions } from './stripe-state';
import { computeSubscriptionTransition, selectTracked, type StripeSubSnapshot } from './subscription-transitions';

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
} = {}): Promise<ReconcileOutcome> {
  const customerId = opts.customerId ?? row.stripeCustomerId;
  const extra = opts.extraPatch ?? {};
  if (!customerId) {
    const updated = Object.keys(extra).length > 0 ? await updateTenantGuarded(tx, row, extra, now) : row;
    return { row: updated, subs: [], tracked: null, customerDeleted: false, noticeIds: [] };
  }

  const knownDeleted = opts.knownCustomerDeleted === true
    || (customerId === row.stripeCustomerId && row.stripeCustomerDeletedAt !== null);
  const { subs, customerDeleted } = await readCustomerSubscriptions(customerId, row.stripeSubscriptionId, knownDeleted);
  const { tracked, duplicateLive } = selectTracked(subs, row.stripeSubscriptionId);
  const result = computeSubscriptionTransition(toLifecycleFacts(row), tracked, subs, duplicateLive, now);

  const patch: TenantPatch = { ...result.patch, ...extra };
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

  return { row: updated, subs, tracked, customerDeleted, noticeIds };
}
