import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env.STRIPE_PRICE_STARTER = 'price_starter_test';
  process.env.STRIPE_PRICE_PRO = 'price_pro_test';
  return { slug: '' };
});

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
// userAction (src/lib/action-result.ts) maps errors by instanceof, so the partial mocks carry the real-shaped classes.
vi.mock('@/lib/session', () => ({
  AuthorizationError: class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); }
  },
  requireAdmin: async () => ({ id: 'admin-1', role: 'admin' }),
  requireAdminFresh: async () => ({ id: 'admin-1', role: 'admin' }),
}));
vi.mock('@/lib/tenant/context', async () => {
  const { getTenantBySlug, invalidateTenant } = await import('@/lib/tenant/registry');
  return {
    WorkspaceReadOnlyError: class WorkspaceReadOnlyError extends Error {},
    getTenantForBilling: async () => {
      invalidateTenant(state.slug);
      const t = await getTenantBySlug(state.slug);
      if (!t || (t.status !== 'active' && t.status !== 'suspended')) throw new Error('This workspace is not available.');
      return t;
    },
  };
});

import { getTenantBillingInfo, openBillingPortal, startCheckout } from '@/server/actions/billing';
import { stripeState } from './fakes/fake-stripe';
import { expectOk, expectFailure } from './helpers';
import { cpReady, auditOf, cleanupLifecycleTenants, daysFrom, getTenantRow, makeTenant } from './lifecycle-helpers';

/** feature-plan-terms-compliance-fixes.md §5.6 / §7 "Billing": checkout guards, customer linking, Pay now. */

describe.skipIf(!cpReady)('billing actions (§5.6)', () => {
  const NOW = new Date();

  beforeEach(async () => {
    stripeState.reset();
    await cleanupLifecycleTenants();
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
  });

  it('concurrent first checkouts create exactly one Stripe customer and link it once', async () => {
    const t = await makeTenant();
    state.slug = t.slug;
    const [a, b] = await Promise.all([expectOk(startCheckout('starter')), expectOk(startCheckout('starter'))]);
    expect(a.url).toBeTruthy();
    expect(b.url).toBeTruthy();
    expect(stripeState.createdCustomers).toBe(1);
    expect((await getTenantRow(t.id)).stripeCustomerId).toMatch(/^cus_/);
  });

  it.each([['active'], ['past_due'], ['incomplete']])('refused while a subscription is %s (→ Manage billing)', async (status) => {
    const customer = stripeState.addCustomer();
    stripeState.addSub(customer, status);
    const t = await makeTenant({ stripeCustomerId: customer });
    state.slug = t.slug;
    await expectFailure(startCheckout('starter'), 'conflict', /already in progress/);
  });

  it('refused for a closed workspace and for a policy suspension', async () => {
    const closed = await makeTenant({ trialEndsAt: daysFrom(NOW, -200), deletionScheduledFor: daysFrom(NOW, -1) });
    state.slug = closed.slug;
    await expectFailure(startCheckout('starter'), 'validation', /closed/);
    const policy = await makeTenant({ status: 'suspended', suspendedAt: NOW, suspensionReason: 'policy' });
    state.slug = policy.slug;
    await expectFailure(startCheckout('starter'), 'validation', /contact support/);
  });

  it('a deleted customer is replaced by a new one (audited); the portal is refused meanwhile', async () => {
    const old = stripeState.addCustomer();
    stripeState.customers.get(old)!.deleted = true;
    const t = await makeTenant({ stripeCustomerId: old, stripeCustomerDeletedAt: daysFrom(NOW, -2) });
    state.slug = t.slug;
    await expectFailure(openBillingPortal(), 'validation', /closed/);
    await expectOk(startCheckout('starter'));
    const row = await getTenantRow(t.id);
    expect(row.stripeCustomerId).not.toBe(old);
    expect(row.stripeCustomerDeletedAt).toBeNull();
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('stripe-customer-replaced');
  });

  it('dunning shows "Pay outstanding balance" (the open invoice\'s hosted page) and no Subscribe', async () => {
    const customer = stripeState.addCustomer();
    const inv = stripeState.addInvoice(customer, null, { hosted_invoice_url: 'https://invoice.stripe.test/pay' });
    const sub = stripeState.addSub(customer, 'past_due', { latestInvoice: inv });
    const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due', pastDueSince: daysFrom(NOW, -3), firstGoodAt: daysFrom(NOW, -60), plan: 'starter' });
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    expect(info.payUrl).toBe('https://invoice.stripe.test/pay');
    expect(info.canSubscribe).toBe(false);
    expect(info.hasCustomer).toBe(true);
  });

  it('plans come from the server with purchasable computed from the configured Stripe prices (P4 §8)', async () => {
    const t = await makeTenant();
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    expect(info.plans.map((p) => [p.key, p.purchasable])).toEqual([
      ['trial', false], ['starter', true], ['pro', true], ['enterprise', Boolean(process.env.STRIPE_PRICE_ENTERPRISE)],
    ]);
    expect(JSON.stringify(info)).not.toMatch(/price_/); // no Stripe price IDs leave the server
  });

  it('after the subscription ended, Subscribe is enabled again — including the previous plan', async () => {
    const customer = stripeState.addCustomer();
    const t = await makeTenant({ stripeCustomerId: customer, subscriptionStatus: 'canceled', plan: 'starter', firstGoodAt: daysFrom(NOW, -100), subscriptionEndedAt: daysFrom(NOW, -5), deletionScheduledFor: daysFrom(NOW, 85) });
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    expect(info.canSubscribe).toBe(true);
    expect(info.payUrl).toBeNull();
    expect(await expectOk(startCheckout('starter'))).toMatchObject({ url: expect.any(String) });
  });
});
