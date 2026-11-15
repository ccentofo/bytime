import { NextRequest, NextResponse, after } from 'next/server';
import type Stripe from 'stripe';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { stripe } from '@/lib/billing/stripe';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { LifecycleVersionConflictError, TenantLockTimeoutError, withLockedPool, withTenantLock } from '@/db/control-plane/locked';
import { reconcileInLock } from '@/lib/billing/reconcile';
import { readCustomerSubscriptions } from '@/lib/billing/stripe-state';
import { isLive } from '@/lib/tenant/lifecycle';
import { raiseAlert, readTenant, recordAudit, updateTenantGuarded } from '@/lib/tenant/lifecycle-store';
import { deliverNotice, enqueueNotice } from '@/lib/tenant/notices';
import { invalidateTenant } from '@/lib/tenant/registry';
import { markSeatSyncDue } from '@/lib/billing/seat-sync';

/**
 * Stripe webhook (feature-plan-terms-compliance-fixes.md §4.3). Never trusts event order or the event payload's
 * subscription state: every subscription-affecting event re-reads Stripe's CURRENT state for the customer under
 * the tenant advisory lock and applies the transition table (src/lib/billing/reconcile.ts).
 */

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'checkout.session.completed',
  'customer.deleted',
]);

/**
 * Checkout events, resolved by the session's metadata slug (feature-plan-per-user-billing.md §6.9 adds the two ACH
 * outcomes: a delayed payment method succeeds or fails after `checkout.session.completed`).
 */
const CHECKOUT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
]);

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

/**
 * Webhook payloads use the ENDPOINT's API version, not the SDK's pinned one. From 2025-03-31.basil on, Stripe
 * moved `invoice.subscription` to `invoice.parent.subscription_details.subscription`; read both so an endpoint
 * created with a newer version never makes us ignore invoice events.
 */
function invoiceSubscriptionOf(inv: Stripe.Invoice): string | null {
  const legacy = idOf((inv as { subscription?: string | { id: string } | null }).subscription);
  if (legacy) return legacy;
  const parent = (inv as { parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null }).parent;
  return idOf(parent?.subscription_details?.subscription ?? null);
}

/** `markDue`: mark the seat sync due after the locked section (feature-plan-per-user-billing.md §6.5). */
type Outcome = { slug: string; noticeIds: string[]; markDue: boolean } | null;

// Stripe requires the RAW body for signature verification.
// Do NOT call req.json() before verifying — it consumes and transforms the body.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 500 });

  const sig = req.headers.get('stripe-signature') ?? '';
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  // Rule 2: resolve the tenant (checkout by metadata slug; everything else by customer id).
  let customerId: string | null = null;
  let tenantId: string | null = null;
  let invoiceSubscriptionId: string | null = null;
  const obj = event.data.object as unknown as Record<string, unknown>;

  if (CHECKOUT_EVENTS.has(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;
    customerId = idOf(session.customer);
    const slug = session.metadata?.slug;
    if (!slug || !customerId) return ignored();
    const [t] = await controlDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
    tenantId = t?.id ?? null;
    if (!tenantId) return ignored(); // unknown slug: no customer link yet
  } else if (SUBSCRIPTION_EVENTS.has(event.type) || event.type === 'customer.updated') {
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const inv = event.data.object as Stripe.Invoice;
      invoiceSubscriptionId = invoiceSubscriptionOf(inv);
      if (!invoiceSubscriptionId) return ignored(); // one-off invoice: not a subscription fact
    }
    customerId = event.type.startsWith('customer.') && !event.type.startsWith('customer.subscription.')
      ? (obj.id as string)
      : idOf(obj.customer as string | { id: string } | null);
    if (!customerId) return ignored();
    const [t] = await controlDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.stripeCustomerId, customerId)).limit(1);
    tenantId = t?.id ?? null;
    if (!tenantId && SUBSCRIPTION_EVENTS.has(event.type)) {
      // §6.9: a subscription on a customer no workspace is linked to (a founder-made subscription on the wrong customer).
      const unknownCustomer = customerId;
      await withLockedPool((db) => raiseAlert(db, { tenantId: null, kind: 'stripe-event-unknown-customer', dedupKey: unknownCustomer, detail: { event: event.type } }, new Date()))
        .catch((e) => console.error('[stripe webhook] alert failed:', e));
    }
  } else {
    return ignored(); // charge.dispute.* and anything else: founder handles in Stripe
  }
  if (!tenantId) return ignored();

  const now = new Date();
  const eventCustomer = customerId;
  let outcome: Outcome;
  try {
    outcome = await withTenantLock(tenantId, async (tx): Promise<Outcome> => {
      const row = await readTenant(tx, tenantId!);
      if (!row) return null;

      // Closed tenant: never write facts, but surface a LIVE subscription that is still billing it.
      if (row.status !== 'active' && row.status !== 'suspended') {
        if (event.type !== 'customer.updated' && row.stripeCustomerId === eventCustomer) {
          const { subs } = await readCustomerSubscriptions(eventCustomer, row.stripeSubscriptionId,
            row.stripeCustomerDeletedAt !== null || event.type === 'customer.deleted');
          const live = subs.filter((s) => isLive(s.status));
          if (live.length > 0) {
            await raiseAlert(tx, { tenantId: row.id, kind: 'live-subscription-on-closed-tenant', detail: { status: row.status, ids: live.map((s) => s.id) } }, now);
          }
        }
        return null;
      }

      if (CHECKOUT_EVENTS.has(event.type)) {
        const session = event.data.object as Stripe.Checkout.Session;
        const extraPatch: Parameters<typeof updateTenantGuarded>[2] = {};
        const email = session.customer_details?.email ?? null;
        if (email) extraPatch.billingEmail = email;
        if (row.stripeCustomerId !== eventCustomer) {
          const replaceable = row.stripeCustomerId === null || row.stripeCustomerDeletedAt !== null;
          const [owner] = await tx.select({ id: tenants.id }).from(tenants)
            .where(and(eq(tenants.stripeCustomerId, eventCustomer), ne(tenants.id, row.id))).limit(1);
          if (!replaceable || owner) {
            await raiseAlert(tx, { tenantId: row.id, kind: 'checkout-customer-conflict', dedupKey: eventCustomer, detail: { current: row.stripeCustomerId, checkout: eventCustomer, otherTenant: owner?.id ?? null } }, now);
            return null; // never overwrite a live customer link
          }
          extraPatch.stripeCustomerId = eventCustomer;
          extraPatch.stripeCustomerDeletedAt = null;
          if (row.stripeCustomerId) {
            await recordAudit(tx, { tenantId: row.id, kind: 'stripe-customer-replaced', actor: 'stripe-webhook', detail: `old=${row.stripeCustomerId} new=${eventCustomer}` });
          }
        }
        const r = await reconcileInLock(tx, row, now, { customerId: eventCustomer, extraPatch });
        const noticeIds = [...r.noticeIds];
        if (event.type === 'checkout.session.async_payment_failed') {
          await raiseAlert(tx, { tenantId: row.id, kind: 'checkout-payment-failed', dedupKey: session.id, detail: { subscription: idOf(session.subscription) } }, now);
          // Only when the subscription never started (incomplete / incomplete_expired): a LIVE subscription's failure is
          // covered by invoice.payment_failed, so one failure sends one email.
          const sessionSub = idOf(session.subscription);
          const snap = sessionSub ? r.subs.find((s) => s.id === sessionSub) : undefined;
          if (!snap || !isLive(snap.status)) {
            const id = await enqueueNotice(tx, row.id, 'bank-payment-failed', new Date(session.created * 1000));
            if (id) noticeIds.push(id);
          }
        }
        const markDue = event.type !== 'checkout.session.async_payment_failed' || r.becameGood;
        return { slug: row.slug, noticeIds, markDue };
      }

      // Rule 3: checkout may have replaced the customer since this event was sent.
      if (row.stripeCustomerId !== eventCustomer) return null;

      if (event.type === 'customer.updated') {
        const email = (event.data.object as Stripe.Customer).email;
        if (email && email !== row.billingEmail) {
          await updateTenantGuarded(tx, row, { billingEmail: email }, now, inArray(tenants.status, ['active', 'suspended']));
        }
        return { slug: row.slug, noticeIds: [], markDue: false };
      }

      const r = await reconcileInLock(tx, row, now, { knownCustomerDeleted: event.type === 'customer.deleted' });

      if (event.type === 'invoice.paid' && invoiceSubscriptionId) {
        const paidSub = r.subs.find((s) => s.id === invoiceSubscriptionId);
        if (!paidSub || !isLive(paidSub.status)) {
          const invoiceId = (event.data.object as Stripe.Invoice).id;
          await raiseAlert(tx, { tenantId: row.id, kind: 'invoice-paid-non-live', dedupKey: invoiceId ?? '', detail: { subscription: invoiceSubscriptionId, status: paidSub?.status ?? 'missing' } }, now);
        }
      }
      const noticeIds = [...r.noticeIds];
      if (event.type === 'invoice.payment_failed' && invoiceSubscriptionId) {
        // §6.9 (Q6, Q11; Terms §4.7): a failed payment no grace notice covers (pastDueSince null after the reconcile,
        // whatever Stripe's status) on a LIVE subscription. The triggers are exclusive with `payment-failed`, so one
        // failure sends one email. An ended tenant gets the founder alert only (its Billing page offers no payment).
        const inv = event.data.object as Stripe.Invoice;
        const failedSub = r.subs.find((s) => s.id === invoiceSubscriptionId);
        if (r.row.pastDueSince === null && failedSub && isLive(failedSub.status)) {
          if (r.row.subscriptionEndedAt === null) {
            const id = await enqueueNotice(tx, row.id, 'bank-payment-failed', new Date(inv.created * 1000));
            if (id) noticeIds.push(id);
          }
          await raiseAlert(tx, { tenantId: row.id, kind: 'payment-failed-subscription-active', dedupKey: inv.id ?? '', detail: { subscription: invoiceSubscriptionId, status: failedSub.status } }, now);
        }
      }
      return { slug: row.slug, noticeIds, markDue: event.type === 'customer.subscription.created' || r.becameGood };
    });
  } catch (err) {
    if (err instanceof TenantLockTimeoutError) {
      return NextResponse.json({ error: 'busy, retry' }, { status: 503 }); // Stripe retries; every attempt re-reads Stripe
    }
    if (err instanceof LifecycleVersionConflictError) {
      await withLockedPool((db) => raiseAlert(db, { tenantId, kind: 'lifecycle-version-conflict', detail: { event: event.id } }, now))
        .catch((e) => console.error('[stripe webhook] alert failed:', e));
      return NextResponse.json({ error: 'conflict, retry' }, { status: 503 });
    }
    console.error(`[stripe webhook] ${event.type} ${event.id} failed:`, err);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 }); // Stripe retries
  }

  if (outcome) {
    invalidateTenant(outcome.slug);
    // §6.5: after the locked section; never throws and is time-capped (≤ 3 s).
    if (outcome.markDue) await markSeatSyncDue(tenantId);
    const ids = outcome.noticeIds;
    if (ids.length > 0) {
      after(async () => {
        for (const id of ids) {
          try {
            await deliverNotice(id);
          } catch (e) {
            console.error(`[stripe webhook] notice ${id} delivery deferred to cron:`, e);
          }
        }
      });
    }
  }
  return NextResponse.json({ received: true });
}

function ignored() {
  return NextResponse.json({ received: true, ignored: true });
}
