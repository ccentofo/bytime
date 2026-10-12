'use server';

import { requireAdmin } from '@/lib/session';
import { getTenantForBilling } from '@/lib/tenant/context';
import { stripe } from '@/lib/billing/stripe';
import { PLANS, type PlanKey } from '@/lib/billing/plans';
import { setTenantStripeCustomer } from '@/lib/billing/tenant-billing';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';

function tenantBaseUrl(slug: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const root = process.env.APP_ROOT_DOMAIN ?? 'localhost';
  const u = new URL(appUrl);
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${slug}.${root}${port}`;
}

export async function startCheckout(plan: PlanKey): Promise<{ url: string }> {
  await requireAdmin();
  const tenant = await getTenantForBilling();
  const priceId = PLANS[plan].priceId;
  if (!priceId) throw new Error('That plan is not purchasable.');

  // Read the tenant registry row to get/create the Stripe customer
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, tenant.slug)).limit(1);
  let customerId = row?.stripeCustomerId ?? undefined;

  if (!customerId) {
    const customer = await stripe.customers.create({
      name: tenant.name,
      metadata: { slug: tenant.slug },
    });
    customerId = customer.id;
    await setTenantStripeCustomer(tenant.slug, customer.id);
  }

  const base = tenantBaseUrl(tenant.slug);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/admin/billing?status=success`,
    cancel_url: `${base}/admin/billing?status=cancelled`,
    metadata: { slug: tenant.slug },
  });
  if (!session.url) throw new Error('Could not start checkout.');
  return { url: session.url };
}

export async function openBillingPortal(): Promise<{ url: string }> {
  await requireAdmin();
  const tenant = await getTenantForBilling();
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, tenant.slug)).limit(1);
  if (!row?.stripeCustomerId) throw new Error('No billing account yet — subscribe first.');

  const portal = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    return_url: `${tenantBaseUrl(tenant.slug)}/admin/billing`,
  });
  return { url: portal.url };
}

export async function getTenantBillingInfo(): Promise<{
  plan: string;
  subscriptionStatus: string | null;
  hasCustomer: boolean;
}> {
  await requireAdmin();
  const tenant = await getTenantForBilling();
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, tenant.slug)).limit(1);
  return {
    plan: row?.plan ?? 'trial',
    subscriptionStatus: row?.subscriptionStatus ?? null,
    hasCustomer: Boolean(row?.stripeCustomerId),
  };
}
