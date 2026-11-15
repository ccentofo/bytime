import 'server-only';
import type Stripe from 'stripe';
import { stripe } from './stripe';
import { planForSubscription } from './plans';
import type { StripeSubSnapshot } from './subscription-transitions';

/**
 * Reads Stripe's CURRENT state for a customer (feature-plan-terms-compliance-fixes.md §4.3 rule 4, §4.4). Called
 * inside locked sections, so every request has a short timeout and no SDK retries (§2 latency budget: at most 3
 * Stripe calls per locked section).
 */
const IN_LOCK = { timeout: 5000, maxNetworkRetries: 0 } as const;

function isResourceMissing(err: unknown): boolean {
  return (err as { code?: string })?.code === 'resource_missing';
}

function toSnapshot(s: Stripe.Subscription): StripeSubSnapshot {
  // feature-plan-per-user-billing.md §6.2: 'standard' when SOME item is on a Standard price; anything else (a custom
  // Enterprise price, a missing STRIPE_PRICE_STANDARD_* env value) is null = "leave the plan as it is", so a paying
  // customer's plan is never downgraded. Tolerates any payload shape.
  const facts = planForSubscription(s.items?.data ?? null);
  return {
    id: s.id,
    status: s.status,
    created: new Date(s.created * 1000),
    endedAt: s.ended_at ? new Date(s.ended_at * 1000) : null,
    currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000) : null,
    plan: facts?.plan ?? null,
    interval: facts?.interval ?? null,
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
    collectionMethod: typeof s.collection_method === 'string' ? s.collection_method : null,
  };
}

/**
 * A `resource_missing` from a customer-scoped list means "empty" ONLY for a confirmed-deleted customer. Anything
 * else (wrong key, test/live mismatch) is an error — never read as "no subscriptions / no invoices".
 */
async function customerConfirmedDeleted(customerId: string, knownDeleted: boolean): Promise<boolean> {
  if (knownDeleted) return true;
  try {
    const c = await stripe.customers.retrieve(customerId, IN_LOCK);
    return (c as Stripe.DeletedCustomer).deleted === true;
  } catch {
    return false;
  }
}

export interface CustomerSubscriptions {
  subs: StripeSubSnapshot[];
  /** The customer is confirmed deleted in Stripe. */
  customerDeleted: boolean;
}

/** All subscriptions for the customer (status 'all'), including the tracked one even if the list omits it. */
export async function readCustomerSubscriptions(
  customerId: string,
  trackedId: string | null,
  knownDeleted: boolean,
): Promise<CustomerSubscriptions> {
  let subs: StripeSubSnapshot[] = [];
  let customerDeleted = knownDeleted;
  try {
    const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 }, IN_LOCK);
    subs = page.data.map(toSnapshot);
  } catch (err) {
    if (!isResourceMissing(err)) throw err;
    if (!(await customerConfirmedDeleted(customerId, knownDeleted))) throw err;
    customerDeleted = true;
  }
  if (trackedId && !subs.some((s) => s.id === trackedId)) {
    try {
      subs.push(toSnapshot(await stripe.subscriptions.retrieve(trackedId, IN_LOCK)));
    } catch (err) {
      if (!isResourceMissing(err)) throw err; // tracked subscription truly gone: nothing to add
    }
  }
  return { subs, customerDeleted };
}

export interface OpenInvoiceState {
  invoiceId: string;
  subscriptionId: string | null;
  /** ACH/bank payment settling. */
  processing: boolean;
  /** ACH microdeposit verification pending (counts as in flight only within its observation window). */
  microdeposit: boolean;
  /** feature-plan-per-user-billing.md §6.2: null for a charge-automatically invoice. */
  dueDate: Date | null;
  hostedUrl: string | null;
  attemptCount: number;
}

function toOpenInvoiceState(inv: Stripe.Invoice): OpenInvoiceState {
  const pi = typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
  return {
    invoiceId: inv.id,
    subscriptionId: typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id ?? null,
    processing: pi?.status === 'processing',
    microdeposit: pi?.status === 'requires_action' && pi.next_action?.type === 'verify_with_microdeposits',
    dueDate: typeof inv.due_date === 'number' ? new Date(inv.due_date * 1000) : null,
    hostedUrl: inv.hosted_invoice_url ?? null,
    attemptCount: typeof inv.attempt_count === 'number' ? inv.attempt_count : 0,
  };
}

/** The customer's open invoices with their payment state (paginated). `resource_missing` = empty only if deleted. */
export async function readOpenInvoices(customerId: string, knownDeleted: boolean): Promise<OpenInvoiceState[]> {
  const out: OpenInvoiceState[] = [];
  let startingAfter: string | undefined;
  try {
    for (;;) {
      const page = await stripe.invoices.list({
        customer: customerId, status: 'open', limit: 100, expand: ['data.payment_intent'],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      }, IN_LOCK);
      for (const inv of page.data) out.push(toOpenInvoiceState(inv));
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
  } catch (err) {
    if (!isResourceMissing(err)) throw err;
    if (!(await customerConfirmedDeleted(customerId, knownDeleted))) throw err;
    return [];
  }
  return out;
}

/**
 * feature-plan-per-user-billing.md §6.2 (webhook path): one subscription's open invoices in ONE call, with the payment
 * intent expanded so "processing" is known (lead ruling B2). `resource_missing` = empty only for a confirmed-deleted
 * customer; any other error throws (the event is retried).
 */
export async function listOpenInvoicesForSubscription(
  subscriptionId: string,
  customerId: string,
  knownDeleted: boolean,
): Promise<OpenInvoiceState[]> {
  try {
    const page = await stripe.invoices.list({
      subscription: subscriptionId, status: 'open', limit: 100, expand: ['data.payment_intent'],
    }, IN_LOCK);
    return page.data.map(toOpenInvoiceState);
  } catch (err) {
    if (!isResourceMissing(err)) throw err;
    if (!(await customerConfirmedDeleted(customerId, knownDeleted))) throw err;
    return [];
  }
}

/** Cancel a subscription; already-canceled / missing counts as success. */
export async function cancelSubscriptionIdempotent(subscriptionId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId, undefined, IN_LOCK);
  } catch (err) {
    if (isResourceMissing(err)) return;
    // Decide by Stripe's actual state, never by error text: success only if it is now canceled.
    const current = await retrieveSubscription(subscriptionId);
    if (!current || current.status === 'canceled' || current.status === 'incomplete_expired') return;
    throw err;
  }
}

/** Retrieve one subscription now (per-subscription locked sections). */
export async function retrieveSubscription(subscriptionId: string): Promise<StripeSubSnapshot | null> {
  try {
    return toSnapshot(await stripe.subscriptions.retrieve(subscriptionId, IN_LOCK));
  } catch (err) {
    if (isResourceMissing(err)) return null;
    throw err;
  }
}

/** Void an open invoice, or mark it uncollectible if Stripe refuses to void it. Already closed = success. */
export async function closeOpenInvoice(invoiceId: string): Promise<void> {
  try {
    await stripe.invoices.voidInvoice(invoiceId, undefined, IN_LOCK);
  } catch (err) {
    if (isResourceMissing(err)) return;
    try {
      await stripe.invoices.markUncollectible(invoiceId, undefined, IN_LOCK);
    } catch (err2) {
      const inv = await stripe.invoices.retrieve(invoiceId, IN_LOCK);
      if (inv.status !== 'open') return; // paid/void/uncollectible meanwhile
      throw err2;
    }
  }
}

/** Whether an observed invoice is still open (re-check of stale payment-pending observations). */
export async function isInvoiceOpen(invoiceId: string): Promise<boolean> {
  try {
    return (await stripe.invoices.retrieve(invoiceId, IN_LOCK)).status === 'open';
  } catch (err) {
    if (isResourceMissing(err)) return false;
    throw err;
  }
}
