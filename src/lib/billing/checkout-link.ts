import 'server-only';
import { and, eq, ne } from 'drizzle-orm';
import { tenants } from '@/db/control-plane/schema';
import type { ControlTx } from '@/db/control-plane/locked';
import { raiseAlert, recordAudit, type TenantRow, updateTenantGuarded } from '@/lib/tenant/lifecycle-store';

type TenantPatch = Parameters<typeof updateTenantGuarded>[2];

/**
 * The checkout link rule (feature-plan-control-plane-disaster.md §6.10 step 1: extracted from the Stripe webhook's
 * checkout branch, behaviour unchanged), shared by the webhook and `tenant:admin stripe-resync`. Called inside the
 * tenant lock when a completed checkout's customer differs from the row's:
 *  - replaceable = the row has no customer, or its customer is known deleted (the resync also counts a customer it just
 *    read as deleted in Stripe: it may have been replaced in a rolled-back window);
 *  - and no OTHER tenant owns the checkout's customer;
 *  otherwise a `checkout-customer-conflict` alert and no link (never overwrite a live customer link).
 * A replaced customer is audited `stripe-customer-replaced`.
 */
export async function checkoutLinkPatch(tx: ControlTx, row: TenantRow, customerId: string, o: { actor: string; now: Date; currentCustomerDeleted?: boolean }):
  Promise<{ ok: true; patch: TenantPatch } | { ok: false }> {
  const replaceable = row.stripeCustomerId === null || row.stripeCustomerDeletedAt !== null || o.currentCustomerDeleted === true;
  const [owner] = await tx.select({ id: tenants.id }).from(tenants)
    .where(and(eq(tenants.stripeCustomerId, customerId), ne(tenants.id, row.id))).limit(1);
  if (!replaceable || owner) {
    await raiseAlert(tx, { tenantId: row.id, kind: 'checkout-customer-conflict', dedupKey: customerId, detail: { current: row.stripeCustomerId, checkout: customerId, otherTenant: owner?.id ?? null } }, o.now);
    return { ok: false };
  }
  if (row.stripeCustomerId) {
    await recordAudit(tx, { tenantId: row.id, kind: 'stripe-customer-replaced', actor: o.actor, detail: `old=${row.stripeCustomerId} new=${customerId}` });
  }
  return { ok: true, patch: { stripeCustomerId: customerId, stripeCustomerDeletedAt: null } };
}
