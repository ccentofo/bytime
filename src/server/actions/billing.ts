'use server';

import type Stripe from 'stripe';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { getTenantForBilling } from '@/lib/tenant/context';
import { stripe } from '@/lib/billing/stripe';
import { PLANS, type PlanKey } from '@/lib/billing/plans';
import { ensureStripeCustomer } from '@/lib/billing/tenant-billing';
import { getTenantAccess, isDunning, isLive } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { ConflictError, UserFacingError } from '@/lib/errors';

async function readTenantRow(slug: string) {
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (!row) throw new UserFacingError('Unknown workspace.', 'not_found');
  return row;
}

/** A LIVE or `incomplete` subscription means a plan already exists or a payment is pending (§5.6). */
const BLOCKS_NEW_CHECKOUT = (status: string | null) => status !== null && (isLive(status) || status === 'incomplete');

export async function startCheckout(plan: PlanKey): Promise<{ url: string }> {
  await requireAdminFresh();
  const tenant = await getTenantForBilling(); // refuses deleting/deleted/provisioning
  const priceId = PLANS[plan].priceId;
  if (!priceId) throw new UserFacingError('That plan is not purchasable.');

  const row = await readTenantRow(tenant.slug);
  if (getTenantAccess(toLifecycleFacts(row), new Date()) === 'closed') {
    throw new UserFacingError('This workspace is closed and can no longer be subscribed.');
  }
  if (row.status === 'suspended' && row.suspensionReason === 'policy') {
    throw new UserFacingError('This workspace is suspended. Please contact support.');
  }

  const customerId = await ensureStripeCustomer(row.id);

  // Authoritative duplicate check against Stripe (the mirror can lag a webhook).
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  if (subs.data.some((s) => BLOCKS_NEW_CHECKOUT(s.status))) {
    throw new ConflictError('A subscription or payment is already in progress. Use Manage billing to change plans or pay.');
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
  if (!session.url) throw new UserFacingError('Could not start checkout.');
  return { url: session.url };
}

export async function openBillingPortal(): Promise<{ url: string }> {
  await requireAdminFresh();
  const tenant = await getTenantForBilling();
  const row = await readTenantRow(tenant.slug);
  if (!row.stripeCustomerId) throw new UserFacingError('No billing account yet — subscribe first.');
  if (row.stripeCustomerDeletedAt) throw new UserFacingError('Your billing account was closed — subscribe again to create a new one.');

  const portal = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    return_url: `${tenantBaseUrl(tenant.slug)}/admin/billing`,
  });
  return { url: portal.url };
}

export interface TenantBillingInfo {
  plan: string;
  subscriptionStatus: string | null;
  /** A usable (not deleted) Stripe customer exists: Manage billing is available. */
  hasCustomer: boolean;
  /** Nothing LIVE or incomplete: Subscribe is enabled for every purchasable plan, including the previous one. */
  canSubscribe: boolean;
  /** DUNNING / suspended for non-payment: the open invoice's Stripe-hosted payment page. */
  payUrl: string | null;
  suspensionReason: 'nonpayment' | 'policy' | null;
}

export async function getTenantBillingInfo(): Promise<TenantBillingInfo> {
  await requireAdmin();
  const tenant = await getTenantForBilling();
  const row = await readTenantRow(tenant.slug);
  const hasCustomer = Boolean(row.stripeCustomerId) && !row.stripeCustomerDeletedAt;

  let payUrl: string | null = null;
  const owes = isDunning(row.subscriptionStatus) || (row.status === 'suspended' && row.suspensionReason === 'nonpayment');
  if (owes && hasCustomer && row.stripeSubscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId, { expand: ['latest_invoice'] }, { timeout: 5000 });
      const inv = sub.latest_invoice as Stripe.Invoice | null;
      if (inv && typeof inv === 'object' && inv.status === 'open') payUrl = inv.hosted_invoice_url ?? null;
    } catch (err) {
      console.error('[billing] could not load the open invoice:', err);
    }
  }

  return {
    plan: row.plan ?? 'trial',
    subscriptionStatus: row.subscriptionStatus ?? null,
    hasCustomer,
    canSubscribe: !BLOCKS_NEW_CHECKOUT(row.subscriptionStatus ?? null) && row.suspensionReason !== 'policy',
    payUrl,
    suspensionReason: (row.suspensionReason as TenantBillingInfo['suspensionReason']) ?? null,
  };
}
