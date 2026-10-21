import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/billing/stripe';
import {
  findTenantByStripeCustomer,
  applyActiveSubscription,
  applyPastDue,
  applySubscriptionEnded,
  applySubscriptionBookkeeping,
  applyCheckoutCompleted,
  refreshBillingEmail,
} from '@/lib/billing/tenant-billing';
import { planForPriceId } from '@/lib/billing/plans';

/**
 * Stripe webhook (feature-plan-terms-compliance.md T5). Every subscription-affecting event goes
 * through the tenant-billing.ts helpers, which enforce ordering (ignore anything no newer than
 * `last_stripe_event_at`) and the various idempotency rules documented there.
 */

// Stripe requires the RAW body for signature verification.
// Do NOT call req.json() before verifying — it consumes and transforms the body.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 500 });

  const sig = req.headers.get('stripe-signature') ?? '';
  const raw = await req.text(); // raw body string for signature verification

  let event: import('stripe').default.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  const eventCreatedAt = new Date(event.created * 1000);

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as import('stripe').default.Subscription;
      const row = await findTenantByStripeCustomer(sub.customer as string);
      if (!row) break; // unknown customer — ignore
      const priceId = sub.items.data[0]?.price?.id ?? null;
      const plan = planForPriceId(priceId);

      if (sub.status === 'active' || sub.status === 'trialing') {
        await applyActiveSubscription(row, {
          stripeSubscriptionId: sub.id, subscriptionStatus: sub.status, plan, eventCreatedAt,
        });
      } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
        await applyPastDue(row, { stripeSubscriptionId: sub.id, subscriptionStatus: sub.status, eventCreatedAt });
      } else {
        await applySubscriptionBookkeeping(row, {
          stripeSubscriptionId: sub.id, subscriptionStatus: sub.status, plan, eventCreatedAt,
        });
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as import('stripe').default.Subscription;
      const row = await findTenantByStripeCustomer(sub.customer as string);
      if (!row) break;
      await applySubscriptionEnded(row, { subscriptionStatus: sub.status, eventCreatedAt });
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object as import('stripe').default.Invoice;
      const row = await findTenantByStripeCustomer(inv.customer as string);
      if (!row) break;
      await applyPastDue(row, { subscriptionStatus: 'past_due', eventCreatedAt });
      break;
    }
    case 'checkout.session.completed': {
      const session = event.data.object as import('stripe').default.Checkout.Session;
      const slug = session.metadata?.slug;
      const customerId = session.customer as string | null;
      if (!slug || !customerId) break;
      await applyCheckoutCompleted(slug, {
        stripeCustomerId: customerId,
        billingEmail: session.customer_details?.email ?? null,
      });
      break;
    }
    case 'customer.updated': {
      const customer = event.data.object as import('stripe').default.Customer;
      await refreshBillingEmail(customer.id, customer.email ?? null);
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
