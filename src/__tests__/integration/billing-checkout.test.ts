import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_month_test';
  process.env.STRIPE_PRICE_STANDARD_ANNUAL = 'price_std_year_test';
  return { slug: '', unauthenticated: false };
});

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
// userAction (src/lib/action-result.ts) maps errors by instanceof, so the partial mocks carry the real-shaped classes.
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); }
  }
  const admin = async () => {
    if (state.unauthenticated) throw new AuthorizationError('unauthenticated', 'Not signed in.');
    return { id: 'admin-1', role: 'admin' };
  };
  return { AuthorizationError, requireAdmin: admin, requireAdminFresh: admin };
});
vi.mock('@/lib/tenant/context', async () => {
  const { getTenantBySlug, invalidateTenant } = await import('@/lib/tenant/registry');
  return {
    getTenantForBilling: async () => {
      invalidateTenant(state.slug);
      const t = await getTenantBySlug(state.slug);
      if (!t || (t.status !== 'active' && t.status !== 'suspended')) throw new Error('This workspace is not available.');
      return t;
    },
  };
});

import bcrypt from 'bcryptjs';
import * as schema from '@/db/schema';
import { getTenantBillingInfo, openBillingPortal, startCheckout } from '@/server/actions/billing';
import { billingTenantReads } from '@/server/internal/billing-reads';
import { paymentTile } from '@/app/(app)/settings/billing/BillingClient';
import { cleanupTestData, getTestDb } from './helpers';
import { stripeState } from './fakes/fake-stripe';
import { expectOk, expectFailure } from './helpers';
import { cpReady, auditOf, cleanupLifecycleTenants, daysFrom, getTenantRow, makeTenant } from './lifecycle-helpers';

/** feature-plan-terms-compliance-fixes.md §5.6 / §7 "Billing": checkout guards, customer linking, Pay now. */

describe.skipIf(!cpReady)('billing actions (§5.6)', () => {
  const NOW = new Date();

  beforeEach(async () => {
    stripeState.reset();
    state.unauthenticated = false;
    process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_month_test';
    process.env.STRIPE_PRICE_STANDARD_ANNUAL = 'price_std_year_test';
    await cleanupLifecycleTenants();
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
  });

  it('concurrent first checkouts create exactly one Stripe customer and link it once', async () => {
    const t = await makeTenant();
    state.slug = t.slug;
    const [a, b] = await Promise.all([expectOk(startCheckout('month')), expectOk(startCheckout('month'))]);
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
    await expectFailure(startCheckout('month'), 'conflict', /already in progress/);
  });

  it('refused for a closed workspace and for a policy suspension', async () => {
    const closed = await makeTenant({ trialEndsAt: daysFrom(NOW, -200), deletionScheduledFor: daysFrom(NOW, -1) });
    state.slug = closed.slug;
    await expectFailure(startCheckout('month'), 'validation', /closed/);
    const policy = await makeTenant({ status: 'suspended', suspendedAt: NOW, suspensionReason: 'policy' });
    state.slug = policy.slug;
    await expectFailure(startCheckout('month'), 'validation', /contact support/);
  });

  it('a deleted customer is replaced by a new one (audited); the portal is refused meanwhile', async () => {
    const old = stripeState.addCustomer();
    stripeState.customers.get(old)!.deleted = true;
    const t = await makeTenant({ stripeCustomerId: old, stripeCustomerDeletedAt: daysFrom(NOW, -2) });
    state.slug = t.slug;
    await expectFailure(openBillingPortal(), 'validation', /closed/);
    await expectOk(startCheckout('month'));
    const row = await getTenantRow(t.id);
    expect(row.stripeCustomerId).not.toBe(old);
    expect(row.stripeCustomerDeletedAt).toBeNull();
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('stripe-customer-replaced');
  });

  it('dunning: payUrl is the open invoice\'s hosted page, and no Subscribe', async () => {
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    stripeState.addInvoice(customer, sub, { hosted_invoice_url: 'https://invoice.stripe.test/pay', created: Math.floor(NOW.getTime() / 1000) - 3 * 86400 });
    const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due', pastDueSince: daysFrom(NOW, -3), firstGoodAt: daysFrom(NOW, -60), plan: 'standard' });
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    expect(info.payUrl).toBe('https://invoice.stripe.test/pay');
    expect(info.canSubscribe).toBe(false);
    expect(info.hasCustomer).toBe(true);
  });

  it('availability comes from the server, computed from the configured Standard prices (P4 §8); no price id leaves it', async () => {
    const t = await makeTenant();
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    expect(info.standardAvailable).toEqual({ month: true, year: true });
    expect(JSON.stringify(info)).not.toMatch(/price_|cus_|sub_/); // no Stripe price or object ids leave the server
  });

  it('after the subscription ended, Subscribe is enabled again', async () => {
    const customer = stripeState.addCustomer();
    const t = await makeTenant({ stripeCustomerId: customer, subscriptionStatus: 'canceled', plan: 'standard', firstGoodAt: daysFrom(NOW, -100), subscriptionEndedAt: daysFrom(NOW, -5), deletionScheduledFor: daysFrom(NOW, 85) });
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    expect(info.canSubscribe).toBe(true);
    expect(info.payUrl).toBeNull();
    expect(await expectOk(startCheckout('month'))).toMatchObject({ url: expect.any(String) });
  });
});

/** feature-plan-per-user-billing.md §6.8, §6.10 / S15, S20, S37, S40. */
describe.skipIf(!cpReady)('per-user checkout and billing info (§6.8, §6.10)', () => {
  const NOW = new Date();
  let hash = '';
  async function setUsers(n: number) {
    await cleanupTestData();
    hash ||= await bcrypt.hash('TestPass123!', 4);
    if (n > 0) {
      await getTestDb().insert(schema.users).values([...Array(n)].map((_, i) => ({
        email: `co-${i}-${Math.random().toString(36).slice(2, 8)}@bytime.dev`, fullName: `U ${i}`, role: 'employee' as const, passwordHash: hash, isActive: true,
      })));
    }
  }
  const originalReads = { ...billingTenantReads };

  beforeEach(async () => {
    stripeState.reset();
    state.unauthenticated = false;
    process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_month_test';
    process.env.STRIPE_PRICE_STANDARD_ANNUAL = 'price_std_year_test';
    Object.assign(billingTenantReads, originalReads);
    await cleanupLifecycleTenants();
  });
  afterEach(async () => {
    Object.assign(billingTenantReads, originalReads);
    await cleanupLifecycleTenants();
    await cleanupTestData();
  });

  it('S15: the session: card and US bank account, promotion codes, quantity = the active-user count, the interval\'s price, metadata', async () => {
    await setUsers(7);
    const t = await makeTenant();
    state.slug = t.slug;
    await expectOk(startCheckout('year'));
    const p = stripeState.checkoutParams[0] as Record<string, any>;
    expect(p.mode).toBe('subscription');
    expect(p.line_items).toEqual([{ price: 'price_std_year_test', quantity: 7 }]);
    expect(p.payment_method_types).toEqual(['card', 'us_bank_account']);
    expect(p.payment_method_options).toEqual({ us_bank_account: { verification_method: 'automatic', financial_connections: { permissions: ['payment_method'] } } });
    expect(p.allow_promotion_codes).toBe(true);
    expect(p.discounts).toBeUndefined();
    expect(p.line_items[0].adjustable_quantity).toBeUndefined();
    expect(p.subscription_data).toEqual({ metadata: { slug: t.slug, tenantId: t.id } });
    expect(p.metadata).toEqual({ slug: t.slug });
    await expectOk(startCheckout('month'));
    expect((stripeState.checkoutParams[1] as Record<string, any>).line_items).toEqual([{ price: 'price_std_month_test', quantity: 7 }]);
  });

  it('S15: zero active users still checks out at quantity 1', async () => {
    await setUsers(0);
    const t = await makeTenant();
    state.slug = t.slug;
    await expectOk(startCheckout('month'));
    expect((stripeState.checkoutParams[0] as Record<string, any>).line_items[0].quantity).toBe(1);
  });

  it('S15: an invalid interval is refused; validated AFTER the guard (an unauthenticated bad call gets the auth refusal)', async () => {
    const t = await makeTenant();
    state.slug = t.slug;
    await expectFailure(startCheckout('weekly' as never), 'validation', /^Choose monthly or annual billing\.$/);
    state.unauthenticated = true;
    await expectFailure(startCheckout('weekly' as never), 'unauthenticated');
    expect(stripeState.calls).toEqual([]);
  });

  it('S15: more than 100 active users → the exact cap message, before any Stripe call', async () => {
    await setUsers(101);
    const t = await makeTenant();
    state.slug = t.slug;
    await expectFailure(startCheckout('month'), 'validation', /^Your plan covers up to 100 users\. Contact us at support@cadenzpoint\.com to add more\.$/);
    expect(stripeState.calls).toEqual([]);
    await setUsers(100);
    await expectOk(startCheckout('month'));
  });

  it('S15: "That plan is not available yet." when the interval\'s price env is empty', async () => {
    const t = await makeTenant();
    state.slug = t.slug;
    process.env.STRIPE_PRICE_STANDARD_ANNUAL = '';
    await expectFailure(startCheckout('year'), 'validation', /^That plan is not available yet\.$/);
    await expectOk(startCheckout('month'));
  });

  it('S15: works when suspended for non-payment (the count comes through the row\'s URL; the old subscription is terminated)', async () => {
    await setUsers(3);
    const customer = stripeState.addCustomer();
    stripeState.addSub(customer, 'canceled', { endedAt: daysFrom(NOW, -5) });
    const t = await makeTenant({ stripeCustomerId: customer, status: 'suspended', suspendedAt: daysFrom(NOW, -3), suspensionReason: 'nonpayment', firstGoodAt: daysFrom(NOW, -80), subscriptionStatus: 'canceled' });
    state.slug = t.slug;
    await expectOk(startCheckout('month'));
    expect((stripeState.checkoutParams[0] as Record<string, any>).line_items[0].quantity).toBe(3);
  });

  it('S20: suspended for non-payment → getTenantBillingInfo resolves with payUrl and seats; a failing tenant-DB read → seats null, still payable', async () => {
    await setUsers(4);
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    stripeState.addInvoice(customer, sub, { hosted_invoice_url: 'https://invoice.stripe.test/pay-now', created: Math.floor(NOW.getTime() / 1000) - 86400 });
    const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due', pastDueSince: daysFrom(NOW, -20), firstGoodAt: daysFrom(NOW, -80), status: 'suspended', suspendedAt: daysFrom(NOW, -3), suspensionReason: 'nonpayment', plan: 'standard' });
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    expect(info.payUrl).toBe('https://invoice.stripe.test/pay-now');
    expect(info.seats).toEqual({ active: 4, limit: 100 });
    expect(info.access).toBe('billing_only');
    billingTenantReads.countActiveUsers = async () => { throw new Error('tenant DB down'); };
    const degraded = await getTenantBillingInfo();
    expect(degraded.seats).toBeNull();
    expect(degraded.payUrl).toBe('https://invoice.stripe.test/pay-now');
  });

  it('S37: the tenant-DB read hangs → getTenantBillingInfo resolves within about 3 s with seats null', async () => {
    const t = await makeTenant();
    state.slug = t.slug;
    billingTenantReads.readWorkspaceTimeZone = () => new Promise(() => {});
    const started = Date.now();
    const info = await getTenantBillingInfo();
    const ms = Date.now() - started;
    expect(info.seats).toBeNull();
    expect(ms).toBeGreaterThanOrEqual(2900);
    expect(ms).toBeLessThan(4500);
  });

  it('S40: invoiced and overdue while Stripe says active → Payment row 2 with the Pay button; uncollectible-only → the Pay button uses the uncollectible invoice', async () => {
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'active', { collection_method: 'send_invoice' });
    stripeState.addInvoice(customer, sub, { due_date: Math.floor(NOW.getTime() / 1000) - 3 * 86400, hosted_invoice_url: 'https://pay.test/overdue', created: Math.floor(NOW.getTime() / 1000) - 33 * 86400 });
    const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'active', collectionMethod: 'send_invoice', pastDueSince: daysFrom(NOW, -3), firstGoodAt: daysFrom(NOW, -80), plan: 'standard' });
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    const tile = paymentTile(info);
    expect(tile.big).toBe('Payment overdue');
    expect(tile.action).toEqual({ label: 'Pay the invoice', href: 'https://pay.test/overdue' });

    const c2 = stripeState.addCustomer();
    const s2 = stripeState.addSub(c2, 'past_due');
    stripeState.addInvoice(c2, s2, { status: 'uncollectible', hosted_invoice_url: 'https://pay.test/uncollectible', created: Math.floor(NOW.getTime() / 1000) - 86400 });
    const t2 = await makeTenant({ stripeCustomerId: c2, stripeSubscriptionId: s2, subscriptionStatus: 'past_due', pastDueSince: daysFrom(NOW, -3), firstGoodAt: daysFrom(NOW, -80), plan: 'standard' });
    state.slug = t2.slug;
    const info2 = await getTenantBillingInfo();
    expect(info2.payUrl).toBe('https://pay.test/uncollectible');
    expect(info2.openInvoiceCount).toBe(0);
  });

  it('M4: dates are formatted in the workspace time zone (Pacific/Auckland: a period end of Dec 1, 20:00 UTC is Dec 2 there)', async () => {
    await getTestDb().insert(schema.workspaceSettings).values({ id: 1, timezone: 'Pacific/Auckland' })
      .onConflictDoUpdate({ target: schema.workspaceSettings.id, set: { timezone: 'Pacific/Auckland' } });
    const t = await makeTenant({ trialEndsAt: new Date('2026-12-01T20:00:00Z'), currentPeriodEnd: new Date('2026-12-01T20:00:00Z'), subscriptionEndedAt: null });
    state.slug = t.slug;
    const info = await getTenantBillingInfo();
    expect(info.trialEnd).toBe('Dec 2, 2026');
    expect(info.renewsOn).toBe('Dec 2, 2026');
  });

  it('M14: billedQuantityApplies only when the seat row\'s subscription is the tenant\'s', async () => {
    const { tenantSeatBilling } = await import('@/db/control-plane/schema');
    const { controlDb } = await import('@/db/control-plane');
    const t = await makeTenant({ stripeSubscriptionId: 'sub_current', subscriptionStatus: 'active', plan: 'standard' });
    state.slug = t.slug;
    await controlDb.insert(tenantSeatBilling).values({ tenantId: t.id, stripeSubscriptionId: 'sub_current', stripeQuantity: 9 });
    expect(await getTenantBillingInfo()).toMatchObject({ billedQuantity: 9, billedQuantityApplies: true });
    await controlDb.update(tenantSeatBilling).set({ stripeSubscriptionId: 'sub_previous' });
    expect(await getTenantBillingInfo()).toMatchObject({ billedQuantity: 9, billedQuantityApplies: false });
  });

  it('M15: canSubscribe is false when closed and when policy-held (nothing LIVE in either)', async () => {
    const closed = await makeTenant({ trialEndsAt: daysFrom(NOW, -200), deletionScheduledFor: daysFrom(NOW, -1) });
    state.slug = closed.slug;
    expect(await getTenantBillingInfo()).toMatchObject({ access: 'closed', canSubscribe: false });
    const policy = await makeTenant({ status: 'suspended', suspendedAt: NOW, suspensionReason: 'policy' });
    state.slug = policy.slug;
    expect((await getTenantBillingInfo()).canSubscribe).toBe(false);
    const open = await makeTenant();
    state.slug = open.slug;
    expect((await getTenantBillingInfo()).canSubscribe).toBe(true);
  });

  it('M6: the interval is validated after the tenant, closed and policy guards', async () => {
    const closed = await makeTenant({ trialEndsAt: daysFrom(NOW, -200), deletionScheduledFor: daysFrom(NOW, -1) });
    state.slug = closed.slug;
    await expectFailure(startCheckout('weekly' as never), 'validation', /closed/);
    const policy = await makeTenant({ status: 'suspended', suspendedAt: NOW, suspensionReason: 'policy' });
    state.slug = policy.slug;
    await expectFailure(startCheckout('weekly' as never), 'validation', /contact support/);
  });

  it('FR6: the checkout count is capped at 3 s: a hanging read → "Couldn\'t count your users. Please try again." and no Stripe call', async () => {
    const t = await makeTenant();
    state.slug = t.slug;
    billingTenantReads.countActiveUsers = () => new Promise(() => {});
    const started = Date.now();
    await expectFailure(startCheckout('month'), 'validation', /^Couldn't count your users\. Please try again\.$/);
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThanOrEqual(2900);
    expect(ms).toBeLessThan(4500);
    expect(stripeState.calls).toEqual([]);
  });
});
