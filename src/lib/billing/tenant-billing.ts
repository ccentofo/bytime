import 'server-only';
import { eq } from 'drizzle-orm';
import { tenants } from '@/db/control-plane/schema';
import { withLockedPool, withTenantLock } from '@/db/control-plane/locked';
import { invalidateTenant } from '@/lib/tenant/registry';
import { readTenant, recordAudit, updateTenantGuarded } from '@/lib/tenant/lifecycle-store';
import { stripe } from './stripe';

/**
 * The tenant's Stripe customer link (feature-plan-terms-compliance-fixes.md §5.6). Creation uses an idempotency
 * key and links only if the tenant still has no (live) customer, under the tenant advisory lock with the
 * lifecycle_version guard. A deleted customer is replaced by a new one (the old id is audited, never reused).
 */
export async function ensureStripeCustomer(tenantId: string): Promise<string> {
  const [row] = await withLockedPool((db) => db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1));
  if (!row) throw new Error('Unknown workspace.');
  if (row.stripeCustomerId && !row.stripeCustomerDeletedAt) return row.stripeCustomerId;

  const oldId = row.stripeCustomerId;
  const customer = await stripe.customers.create(
    { name: row.name, metadata: { slug: row.slug, tenantId: row.id } },
    { idempotencyKey: `cadenzpoint-customer:${row.id}:${oldId ?? 'first'}` },
  );

  const linked = await withTenantLock(tenantId, async (tx) => {
    const current = await readTenant(tx, tenantId);
    if (!current) throw new Error('Unknown workspace.');
    const stillUnlinked = current.stripeCustomerId === oldId
      && (oldId === null || current.stripeCustomerDeletedAt !== null);
    if (!stillUnlinked) {
      // Someone linked a customer meanwhile: use theirs.
      if (current.stripeCustomerId && !current.stripeCustomerDeletedAt) return current.stripeCustomerId;
      throw new Error('Billing account changed while starting checkout — please try again.');
    }
    await updateTenantGuarded(tx, current, { stripeCustomerId: customer.id, stripeCustomerDeletedAt: null }, new Date());
    if (oldId) {
      await recordAudit(tx, { tenantId, kind: 'stripe-customer-replaced', actor: 'checkout', detail: `old=${oldId} new=${customer.id}` });
    }
    return customer.id;
  });
  invalidateTenant(row.slug);
  return linked;
}
