import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { invalidateTenant } from '@/lib/tenant/registry';
import { decrypt } from '@/lib/encryption';
import { sendTenantNotice, type TenantNoticeTarget } from '@/lib/tenant/notices';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { POST_END_RETENTION_DAYS, PAYMENT_GRACE_DAYS } from '@/lib/tenant/lifecycle-config';
import { isStaleStripeEvent, resolvePastDueSince, shouldApplySubscriptionEnded } from './webhook-logic';
import { PaymentFailedEmail } from '@/lib/email/templates/payment-failed';
import { SubscriptionEndedEmail } from '@/lib/email/templates/subscription-ended';
import React from 'react';

type TenantRow = typeof tenants.$inferSelect;

export async function setTenantStripeCustomer(slug: string, stripeCustomerId: string): Promise<void> {
  await controlDb.update(tenants).set({ stripeCustomerId, updatedAt: new Date() }).where(eq(tenants.slug, slug));
  invalidateTenant(slug);
}

export async function findTenantByStripeCustomer(stripeCustomerId: string): Promise<TenantRow | null> {
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.stripeCustomerId, stripeCustomerId)).limit(1);
  return row ?? null;
}

function noticeTarget(row: TenantRow): TenantNoticeTarget {
  // T7: dbUrlEncrypted is only null for 'deleted'; these notices only ever fire for a tenant
  // whose subscription just changed, which a deleted tenant's can't.
  return { id: row.id, dbUrl: decrypt(row.dbUrlEncrypted!), signupEmail: row.signupEmail, billingEmail: row.billingEmail };
}

/**
 * T5: `customer.subscription.created`/`updated` with status active/trialing. Clears every
 * restrictive fact so a conversion or a re-subscribe from read-only/billing_only/suspended
 * restores `full` immediately (R7, R9's 90-day window).
 */
export async function applyActiveSubscription(row: TenantRow, input: {
  stripeSubscriptionId: string;
  subscriptionStatus: string;
  plan: string;
  eventCreatedAt: Date;
}): Promise<void> {
  if (isStaleStripeEvent(row.lastStripeEventAt, input.eventCreatedAt)) return;
  await controlDb.update(tenants).set({
    stripeSubscriptionId: input.stripeSubscriptionId,
    subscriptionStatus: input.subscriptionStatus,
    plan: input.plan,
    status: 'active',
    pastDueSince: null,
    suspendedAt: null,
    subscriptionEndedAt: null,
    deletionScheduledFor: null,
    lastStripeEventAt: input.eventCreatedAt,
    updatedAt: new Date(),
  }).where(eq(tenants.id, row.id));
  invalidateTenant(row.slug);
}

/**
 * T5/D7: `invoice.payment_failed`, or `customer.subscription.updated` reporting status
 * past_due/unpaid. Stays active — suspension only happens in the lifecycle cron after
 * PAYMENT_GRACE_DAYS with its own prior-notice schedule, never directly from this event.
 */
export async function applyPastDue(row: TenantRow, input: {
  stripeSubscriptionId?: string;
  subscriptionStatus: string;
  eventCreatedAt: Date;
}): Promise<void> {
  if (isStaleStripeEvent(row.lastStripeEventAt, input.eventCreatedAt)) return;
  const pastDueSince = resolvePastDueSince(row.pastDueSince, input.eventCreatedAt);
  await controlDb.update(tenants).set({
    ...(input.stripeSubscriptionId ? { stripeSubscriptionId: input.stripeSubscriptionId } : {}),
    subscriptionStatus: input.subscriptionStatus,
    pastDueSince,
    lastStripeEventAt: input.eventCreatedAt,
    updatedAt: new Date(),
  }).where(eq(tenants.id, row.id));
  invalidateTenant(row.slug);

  // The unique (tenant, kind, scheduled_for) key — keyed on the stable pastDueSince anchor, not
  // "now" — is what keeps Stripe's dunning retries from sending this more than once.
  await sendTenantNotice({
    tenant: noticeTarget(row),
    kind: 'payment-failed',
    scheduledFor: pastDueSince,
    subject: `We couldn't process payment for ${row.name}`,
    react: React.createElement(PaymentFailedEmail, {
      tenantName: row.name,
      graceDays: PAYMENT_GRACE_DAYS,
      appUrl: tenantBaseUrl(row.slug),
    }),
  });
}

/**
 * T5/D9: `customer.subscription.deleted`/canceled. No-op if `subscription_ended_at` is already
 * set — either a duplicate delivery, or the lifecycle cron already terminated this subscription
 * for non-payment first (D9). R9: mode becomes read_only via getTenantAccess, `status` itself
 * stays 'active'.
 */
export async function applySubscriptionEnded(row: TenantRow, input: {
  subscriptionStatus: string;
  eventCreatedAt: Date;
}): Promise<void> {
  if (isStaleStripeEvent(row.lastStripeEventAt, input.eventCreatedAt)) return;
  if (!shouldApplySubscriptionEnded(row.subscriptionEndedAt)) return;

  const deletionScheduledFor = new Date(input.eventCreatedAt.getTime() + POST_END_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await controlDb.update(tenants).set({
    subscriptionStatus: input.subscriptionStatus,
    subscriptionEndedAt: input.eventCreatedAt,
    deletionScheduledFor,
    lastStripeEventAt: input.eventCreatedAt,
    updatedAt: new Date(),
  }).where(eq(tenants.id, row.id));
  invalidateTenant(row.slug);

  await sendTenantNotice({
    tenant: noticeTarget(row),
    kind: 'subscription-ended',
    scheduledFor: deletionScheduledFor,
    subject: `Your ${row.name} subscription has ended`,
    react: React.createElement(SubscriptionEndedEmail, {
      tenantName: row.name,
      retentionDays: POST_END_RETENTION_DAYS,
      appUrl: tenantBaseUrl(row.slug),
    }),
  });
}

/** T5: bookkeeping-only subscription statuses (e.g. incomplete, paused) with no lifecycle-fact
 * consequence — just keep the mirrored Stripe fields current. */
export async function applySubscriptionBookkeeping(row: TenantRow, input: {
  stripeSubscriptionId: string;
  subscriptionStatus: string;
  plan: string;
  eventCreatedAt: Date;
}): Promise<void> {
  if (isStaleStripeEvent(row.lastStripeEventAt, input.eventCreatedAt)) return;
  await controlDb.update(tenants).set({
    stripeSubscriptionId: input.stripeSubscriptionId,
    subscriptionStatus: input.subscriptionStatus,
    plan: input.plan,
    lastStripeEventAt: input.eventCreatedAt,
    updatedAt: new Date(),
  }).where(eq(tenants.id, row.id));
  invalidateTenant(row.slug);
}

/** T5: `checkout.session.completed` — link the customer if startCheckout somehow didn't, and
 * capture the billing email the customer typed into Stripe Checkout. */
export async function applyCheckoutCompleted(slug: string, input: {
  stripeCustomerId: string;
  billingEmail: string | null;
}): Promise<void> {
  await controlDb.update(tenants).set({
    stripeCustomerId: input.stripeCustomerId,
    ...(input.billingEmail ? { billingEmail: input.billingEmail } : {}),
    updatedAt: new Date(),
  }).where(eq(tenants.slug, slug));
  invalidateTenant(slug);
}

/** D10: `customer.updated` — keep the billing email current for notice recipients. */
export async function refreshBillingEmail(stripeCustomerId: string, billingEmail: string | null): Promise<void> {
  if (!billingEmail) return;
  const row = await findTenantByStripeCustomer(stripeCustomerId);
  if (!row) return;
  await controlDb.update(tenants).set({ billingEmail, updatedAt: new Date() }).where(eq(tenants.id, row.id));
  invalidateTenant(row.slug);
}
