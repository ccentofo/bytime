'use server';

import type Stripe from 'stripe';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { getTenantForBilling } from '@/lib/tenant/context';
import { stripe } from '@/lib/billing/stripe';
import { displayPlan, seatLimitFor, standardPriceIds, type BillingInterval, type PlanKey } from '@/lib/billing/plans';
import { STANDARD_CAP_MESSAGE } from '@/lib/billing/plan-copy';
import { choosePayInvoice } from '@/lib/billing/pay-url';
import { ensureStripeCustomer } from '@/lib/billing/tenant-billing';
import { getTenantAccess, isDunning, isGood, isLive, type TenantAccessMode } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants, tenantSeatBilling } from '@/db/control-plane/schema';
import { billingTenantReads, DEFAULT_TIME_ZONE } from '@/server/internal/billing-reads';
import { ConflictError, UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

async function readTenantRow(slug: string) {
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (!row) throw new UserFacingError('Unknown workspace.', 'not_found');
  return row;
}

/** A LIVE or `incomplete` subscription means a plan already exists or a payment is pending (§5.6). */
const BLOCKS_NEW_CHECKOUT = (status: string | null) => status !== null && (isLive(status) || status === 'incomplete');

/**
 * Checkout for Standard, monthly or annual (feature-plan-per-user-billing.md §6.8): the server sets the quantity to
 * the active-user count; card and US bank account (ACH); promotion codes allowed. The guards come first, so an
 * unauthenticated caller learns nothing about which arguments are valid.
 */
export async function startCheckout(interval: BillingInterval): Promise<ActionResult<{ url: string }>> {
  return userAction(async () => {
    await requireAdminFresh();
    const tenant = await getTenantForBilling(); // refuses deleting/deleted/provisioning

    const row = await readTenantRow(tenant.slug);
    if (getTenantAccess(toLifecycleFacts(row), new Date()) === 'closed') {
      throw new UserFacingError('This workspace is closed and can no longer be subscribed.');
    }
    if (row.status === 'suspended' && row.suspensionReason === 'policy') {
      throw new UserFacingError('This workspace is suspended. Please contact support.');
    }
    if (interval !== 'month' && interval !== 'year') throw new UserFacingError('Choose monthly or annual billing.');
    const priceId = standardPriceIds()[interval];
    if (!priceId) throw new UserFacingError('That plan is not available yet.');

    // Through the row's own URL, so it works in billing_only (suspended for non-payment); capped at 3 s (audit FR6).
    let activeUsers: number;
    try {
      activeUsers = await withTimeout(billingTenantReads.countActiveUsers(row), COUNT_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof TimeoutError) throw new UserFacingError("Couldn't count your users. Please try again.");
      throw err;
    }
    if (activeUsers > 100) throw new UserFacingError(STANDARD_CAP_MESSAGE);

    const customerId = await ensureStripeCustomer(row.id);

    // Authoritative duplicate check against Stripe (the mirror can lag a webhook).
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    if (subs.data.some((s) => BLOCKS_NEW_CHECKOUT(s.status))) {
      throw new ConflictError('A subscription or payment is already in progress. Use Manage billing to change plans or pay.');
    }

    const base = tenantBaseUrl(tenant.slug);
    // A quantity that's stale by payment time is corrected by the seat-sync mark set on completion (F9).
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: Math.max(1, activeUsers) }],
      payment_method_types: ['card', 'us_bank_account'],
      payment_method_options: {
        us_bank_account: { verification_method: 'automatic', financial_connections: { permissions: ['payment_method'] } },
      },
      allow_promotion_codes: true,
      subscription_data: { metadata: { slug: tenant.slug, tenantId: row.id } },
      success_url: `${base}/settings/billing?status=success`,
      cancel_url: `${base}/settings/billing?status=cancelled`,
      metadata: { slug: tenant.slug },
    });
    if (!session.url) throw new UserFacingError('Could not start checkout.');
    return { url: session.url };
  });
}

export async function openBillingPortal(): Promise<ActionResult<{ url: string }>> {
  return userAction(async () => {
    await requireAdminFresh();
    const tenant = await getTenantForBilling();
    const row = await readTenantRow(tenant.slug);
    if (getTenantAccess(toLifecycleFacts(row), new Date()) === 'closed') {
      throw new UserFacingError('This workspace is closed and can no longer be subscribed.');
    }
    if (!row.stripeCustomerId) throw new UserFacingError('No billing account yet — subscribe first.');
    if (row.stripeCustomerDeletedAt) throw new UserFacingError('Your billing account was closed — subscribe again to create a new one.');

    const portal = await stripe.billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: `${tenantBaseUrl(tenant.slug)}/settings/billing`,
    });
    return { url: portal.url };
  });
}

/**
 * Everything the Billing page shows, computed on the server (feature-plan-per-user-billing.md §6.10). Price ids and
 * Stripe ids never reach the client. Works in `billing_only`: no tenant-DB accessor that refuses that mode.
 */
export interface TenantBillingInfo {
  plan: PlanKey;
  interval: BillingInterval | null;
  access: TenantAccessMode;
  lifecycleExempt: boolean;
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  /** Preformatted in the workspace time zone ("Nov 15, 2026"). */
  trialEnd: string | null;
  renewsOn: string | null;
  endedOn: string | null;
  /** ceil((trialEndsAt − now) / day); null without a trial date. */
  trialDaysLeft: number | null;
  /** The trial end has passed (server clock). */
  trialEnded: boolean;
  seats: { active: number; limit: number | null } | null;
  /** The seat row's Stripe quantity, or null. */
  billedQuantity: number | null;
  /** The seat row's subscription is the tenant's tracked subscription. */
  billedQuantityApplies: boolean;
  overdue: boolean;
  collectionMethod: string | null;
  ended: boolean;
  trialDateKnown: boolean;
  /** The Stripe-hosted page of the invoice to pay (pay-url.ts), or null. */
  payUrl: string | null;
  openInvoiceCount: number;
  /** A usable (not deleted) Stripe customer exists: Manage billing is available. */
  hasCustomer: boolean;
  /** Nothing LIVE or incomplete, access not closed, not policy-suspended. */
  canSubscribe: boolean;
  standardAvailable: { month: boolean; year: boolean };
  suspensionReason: 'nonpayment' | 'policy' | null;
}

const TENANT_READS_TIMEOUT_MS = 3000;
const COUNT_TIMEOUT_MS = 3000;

class TimeoutError extends Error {}

/**
 * Resolve `work`, or reject with a TimeoutError after `ms`. The losing branch of the race is caught, so it can never
 * become an unhandled rejection; the timer is always cleared.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => {});
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms`)), ms);
  });
  timeout.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const INVOICE_LIST_TIMEOUT_MS = 5000;
const DAY_MS = 86_400_000;

/** The count and time zone, capped at 3 s together; the page renders without them (paying never depends on it). */
async function readSeatsAndTimeZone(row: typeof tenants.$inferSelect): Promise<{ active: number | null; timeZone: string }> {
  try {
    const [active, timeZone] = await withTimeout(
      Promise.all([billingTenantReads.countActiveUsers(row), billingTenantReads.readWorkspaceTimeZone(row)]),
      TENANT_READS_TIMEOUT_MS,
    );
    return { active, timeZone };
  } catch (err) {
    console.error('[billing] could not read the user count / time zone:', err);
    return { active: null, timeZone: DEFAULT_TIME_ZONE };
  }
}

/** The open invoices of the tracked subscription (uncollectible ones as a fallback: their hosted page still takes payment). */
async function readPayableInvoices(subscriptionId: string, now: Date): Promise<{ payUrl: string | null; openInvoiceCount: number }> {
  try {
    const toCandidate = (i: Stripe.Invoice) => ({
      created: i.created,
      dueDate: typeof i.due_date === 'number' ? new Date(i.due_date * 1000) : null,
      hostedUrl: i.hosted_invoice_url ?? null,
    });
    const open = await stripe.invoices.list({ subscription: subscriptionId, status: 'open', limit: 100 }, { timeout: INVOICE_LIST_TIMEOUT_MS, maxNetworkRetries: 0 });
    let candidates = open.data.map(toCandidate);
    if (candidates.length === 0) {
      const uncollectible = await stripe.invoices.list({ subscription: subscriptionId, status: 'uncollectible', limit: 100 }, { timeout: INVOICE_LIST_TIMEOUT_MS, maxNetworkRetries: 0 });
      candidates = uncollectible.data.map(toCandidate);
    }
    return { payUrl: choosePayInvoice(candidates, now)?.hostedUrl ?? null, openInvoiceCount: open.data.length };
  } catch (err) {
    console.error('[billing] could not load the open invoices:', err);
    return { payUrl: null, openInvoiceCount: 0 };
  }
}

export async function getTenantBillingInfo(): Promise<TenantBillingInfo> {
  await requireAdmin();
  const tenant = await getTenantForBilling();
  const row = await readTenantRow(tenant.slug);
  const now = new Date();
  const hasCustomer = Boolean(row.stripeCustomerId) && !row.stripeCustomerDeletedAt;
  const suspendedNonpayment = row.status === 'suspended' && row.suspensionReason === 'nonpayment';
  const wantsInvoices = hasCustomer && Boolean(row.stripeSubscriptionId) && (
    isGood(row.subscriptionStatus) || isDunning(row.subscriptionStatus) || row.subscriptionStatus === 'incomplete' || suspendedNonpayment
  );

  const [reads, invoices, seatRows] = await Promise.all([
    readSeatsAndTimeZone(row),
    wantsInvoices ? readPayableInvoices(row.stripeSubscriptionId!, now) : Promise.resolve({ payUrl: null, openInvoiceCount: 0 }),
    controlDb.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, row.id)).limit(1)
      .catch((err) => { console.error('[billing] could not read the seat row:', err); return []; }),
  ]);
  const seat = seatRows[0];
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: reads.timeZone });
  const date = (d: Date | null) => (d ? fmt.format(d) : null);
  const access = getTenantAccess(toLifecycleFacts(row), now);
  const ids = standardPriceIds();
  const interval = row.planInterval === 'month' || row.planInterval === 'year' ? row.planInterval : null;

  return {
    plan: displayPlan(row.plan ?? 'trial'),
    interval,
    access,
    lifecycleExempt: row.lifecycleExempt,
    subscriptionStatus: row.subscriptionStatus ?? null,
    cancelAtPeriodEnd: row.subscriptionCancelAtPeriodEnd,
    trialEnd: date(row.trialEndsAt),
    renewsOn: date(row.currentPeriodEnd),
    endedOn: date(row.subscriptionEndedAt),
    trialDaysLeft: row.trialEndsAt ? Math.ceil((row.trialEndsAt.getTime() - now.getTime()) / DAY_MS) : null,
    trialEnded: row.trialEndsAt !== null && now.getTime() >= row.trialEndsAt.getTime(),
    seats: reads.active === null ? null : { active: reads.active, limit: seatLimitFor(row.plan ?? 'trial') },
    billedQuantity: seat?.stripeQuantity ?? null,
    billedQuantityApplies: Boolean(seat?.stripeSubscriptionId) && seat?.stripeSubscriptionId === row.stripeSubscriptionId,
    overdue: row.pastDueSince !== null,
    collectionMethod: row.collectionMethod ?? null,
    ended: row.subscriptionEndedAt !== null,
    trialDateKnown: row.trialEndsAt !== null,
    payUrl: invoices.payUrl,
    openInvoiceCount: invoices.openInvoiceCount,
    hasCustomer,
    canSubscribe: !BLOCKS_NEW_CHECKOUT(row.subscriptionStatus ?? null) && access !== 'closed' && row.suspensionReason !== 'policy',
    standardAvailable: { month: ids.month !== null, year: ids.year !== null },
    suspensionReason: (row.suspensionReason as TenantBillingInfo['suspensionReason']) ?? null,
  };
}
