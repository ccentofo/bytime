import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/billing/stripe';
import { applySubscriptionState, findTenantByStripeCustomer } from '@/lib/billing/tenant-billing';
import { planForPriceId } from '@/lib/billing/plans';

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

  const accessFor = (status: string): 'active' | 'suspended' =>
    status === 'active' || status === 'trialing' ? 'active' : 'suspended';

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as import('stripe').default.Subscription;
      const priceId = sub.items.data[0]?.price?.id ?? null;
      await applySubscriptionState({
        stripeCustomerId: sub.customer as string,
        stripeSubscriptionId: sub.id,
        subscriptionStatus: sub.status,
        plan: planForPriceId(priceId),
        access: event.type === 'customer.subscription.deleted' ? 'suspended' : accessFor(sub.status),
      });
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object as import('stripe').default.Invoice;
      const subscriptionId = (inv as any).subscription as string | null ?? null;
      // Preserve the current plan so seat limits remain correct on reactivation.
      // The next customer.subscription.updated event will set the authoritative plan.
      const existingRow = await findTenantByStripeCustomer(inv.customer as string);
      await applySubscriptionState({
        stripeCustomerId: inv.customer as string,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: 'past_due',
        plan: existingRow?.plan ?? 'trial',
        access: 'suspended',
      });
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
