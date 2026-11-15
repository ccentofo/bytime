import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import postgres from 'postgres';

const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => unknown) => { afterTasks.push(fn); },
}));
vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);

import { POST } from '@/app/api/stripe/webhook/route';
import { getTenantAccess } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { setNoticeTimingForTests } from '@/lib/tenant/notices';
import { stripeState } from './fakes/fake-stripe';
import { resendState } from './fakes/fake-resend';
import { cleanupTestData, createTestUser } from './helpers';
import {
  cpReady, auditOf, cleanupLifecycleTenants, daysFrom, getTenantRow, makeTenant, noticesOf, openAlertsOf, setTenant,
  type TenantRow,
} from './lifecycle-helpers';

/**
 * feature-plan-terms-compliance-fixes.md §4.3 / §7 "Webhook": every event re-reads Stripe's CURRENT state for the
 * customer under the tenant lock, so event order, duplicates and lost events can't corrupt lifecycle facts.
 */

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

function event(type: string, object: Record<string, unknown>, created = new Date()) {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, created: sec(created), data: { object } };
}
async function post(evt: ReturnType<typeof event>, signature = 'valid'): Promise<Response> {
  const req = new Request('http://test.localhost/api/stripe/webhook', {
    method: 'POST', body: JSON.stringify(evt), headers: { 'stripe-signature': signature },
  });
  return POST(req as never);
}
const subEvent = (type: string, customer: string, id: string, status = 'active') => event(type, { id, object: 'subscription', customer, status });
const invoiceEvent = (type: string, customer: string, subscription: string | null) =>
  event(type, { id: `in_${Math.random().toString(36).slice(2)}`, object: 'invoice', customer, subscription });
const mode = (row: TenantRow) => getTenantAccess(toLifecycleFacts(row), new Date());

describe.skipIf(!cpReady)('Stripe webhook (§4.3)', () => {
  const NOW = new Date();
  let customer: string;
  let tenant: TenantRow;

  beforeEach(async () => {
    stripeState.reset();
    resendState.reset();
    afterTasks.length = 0;
    setNoticeTimingForTests({ sendTimeoutMs: 200, backoffBaseMs: 5, throttleMs: 0 });
    await cleanupTestData();
    await cleanupLifecycleTenants();
    await createTestUser({ role: 'admin', isActive: true });
    customer = stripeState.addCustomer();
    tenant = await makeTenant({ stripeCustomerId: customer });
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
    await cleanupTestData();
  });

  it('rejects a bad signature with 400 and changes nothing', async () => {
    const res = await post(subEvent('customer.subscription.updated', customer, 'sub_x'), 'forged');
    expect(res.status).toBe(400);
    expect(stripeState.calls).toHaveLength(0);
  });

  it('first GOOD subscription converts the trial: full, first_good_at set, tracked', async () => {
    const s = stripeState.addSub(customer, 'active');
    expect((await post(subEvent('customer.subscription.created', customer, s))).status).toBe(200);
    const row = await getTenantRow(tenant.id);
    expect(row.stripeSubscriptionId).toBe(s);
    expect(row.firstGoodAt).not.toBeNull();
    expect(row.currentPeriodEnd).not.toBeNull();
    expect(mode(row)).toBe('full');
  });

  it('invoice.paid restores a non-payment suspension to full', async () => {
    const s = stripeState.addSub(customer, 'active');
    await setTenant(tenant.id, {
      stripeSubscriptionId: s, subscriptionStatus: 'unpaid', firstGoodAt: daysFrom(NOW, -90),
      pastDueSince: daysFrom(NOW, -20), status: 'suspended', suspendedAt: daysFrom(NOW, -5), suspensionReason: 'nonpayment',
    });
    await post(invoiceEvent('invoice.paid', customer, s));
    const row = await getTenantRow(tenant.id);
    expect(row.status).toBe('active');
    expect(row.pastDueSince).toBeNull();
    expect(row.suspendedAt).toBeNull();
    expect(row.suspensionReason).toBeNull();
    expect(mode(row)).toBe('full');
  });

  it('DUNNING-first sets first_good_at and starts grace once with a payment-failed notice', async () => {
    const s = stripeState.addSub(customer, 'past_due');
    await post(invoiceEvent('invoice.payment_failed', customer, s));
    const row = await getTenantRow(tenant.id);
    expect(row.firstGoodAt).not.toBeNull();
    expect(row.pastDueSince).not.toBeNull();
    const P = row.pastDueSince!;
    await post(invoiceEvent('invoice.payment_failed', customer, s)); // Stripe retry: no clock restart, no resend
    const again = await getTenantRow(tenant.id);
    expect(again.pastDueSince!.getTime()).toBe(P.getTime());
    const notices = (await noticesOf(tenant.id)).filter((n) => n.kind === 'payment-failed');
    expect(notices).toHaveLength(1);
    expect(mode(again)).toBe('full'); // dunning stays full until the cron suspends after notice
  });

  it('S2 active before S1 deleted: adopts S2, never records an end', async () => {
    const s1 = stripeState.addSub(customer, 'canceled', { endedAt: daysFrom(NOW, -1) });
    await setTenant(tenant.id, { stripeSubscriptionId: s1, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -60) });
    const s2 = stripeState.addSub(customer, 'active', { created: new Date() });
    await post(subEvent('customer.subscription.created', customer, s2));
    await post(subEvent('customer.subscription.deleted', customer, s1, 'canceled')); // arrives late
    const row = await getTenantRow(tenant.id);
    expect(row.stripeSubscriptionId).toBe(s2);
    expect(row.subscriptionEndedAt).toBeNull();
    expect(mode(row)).toBe('full');
  });

  it('same-second created/updated delivered out of order end in the current state', async () => {
    const s = stripeState.addSub(customer, 'active');
    const t = new Date();
    await post(event('customer.subscription.updated', { id: s, object: 'subscription', customer, status: 'active' }, t));
    await post(event('customer.subscription.created', { id: s, object: 'subscription', customer, status: 'incomplete' }, t));
    const row = await getTenantRow(tenant.id);
    expect(row.subscriptionStatus).toBe('active');
  });

  it('concurrent events: the section that commits last read the latest state', async () => {
    const s = stripeState.addSub(customer, 'past_due');
    await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -60) });
    stripeState.postDelays.set('subscriptions.list', 400); // W1 holds a past_due read open
    const w1 = post(invoiceEvent('invoice.payment_failed', customer, s));
    await new Promise((r) => setTimeout(r, 100));
    stripeState.setSub(s, { status: 'active' }); // customer pays meanwhile
    const w2 = post(invoiceEvent('invoice.paid', customer, s)); // waits for the lock, reads active
    expect((await w1).status).toBe(200);
    expect((await w2).status).toBe(200);
    const row = await getTenantRow(tenant.id);
    expect(row.subscriptionStatus).toBe('active');
    expect(row.pastDueSince).toBeNull();
  });

  it('two LIVE subscriptions → duplicate alert (F3: alert only), resolved once one is gone', async () => {
    const a = stripeState.addSub(customer, 'active');
    const b = stripeState.addSub(customer, 'active', { created: new Date() });
    await post(subEvent('customer.subscription.created', customer, b));
    expect((await openAlertsOf(tenant.id)).map((x) => x.kind)).toContain('duplicate-live-subscriptions');
    stripeState.setSub(a, { status: 'canceled' });
    await post(subEvent('customer.subscription.deleted', customer, a, 'canceled'));
    expect((await openAlertsOf(tenant.id)).map((x) => x.kind)).not.toContain('duplicate-live-subscriptions');
  });

  it('a GOOD duplicate is selected over a DUNNING tracked subscription', async () => {
    const s1 = stripeState.addSub(customer, 'past_due');
    await setTenant(tenant.id, { stripeSubscriptionId: s1, subscriptionStatus: 'past_due', pastDueSince: daysFrom(NOW, -3), firstGoodAt: daysFrom(NOW, -60) });
    const s2 = stripeState.addSub(customer, 'active', { created: new Date() });
    await post(subEvent('customer.subscription.created', customer, s2));
    const row = await getTenantRow(tenant.id);
    expect(row.stripeSubscriptionId).toBe(s2);
    expect(row.pastDueSince).toBeNull();
  });

  it('an untracked old subscription event changes nothing', async () => {
    const s2 = stripeState.addSub(customer, 'active');
    const old = stripeState.addSub(customer, 'canceled', { endedAt: daysFrom(NOW, -200), created: daysFrom(NOW, -400) });
    await setTenant(tenant.id, { stripeSubscriptionId: s2, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -60) });
    await post(subEvent('customer.subscription.deleted', customer, old, 'canceled'));
    const row = await getTenantRow(tenant.id);
    expect(row.stripeSubscriptionId).toBe(s2);
    expect(row.subscriptionEndedAt).toBeNull();
  });

  it('canceled after paying → read_only, D = E + 90 d, subscription-ended notice; a repeat is a no-op', async () => {
    const E = daysFrom(NOW, -1);
    const s = stripeState.addSub(customer, 'canceled', { endedAt: E });
    await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -60) });
    await post(subEvent('customer.subscription.deleted', customer, s, 'canceled'));
    const row = await getTenantRow(tenant.id);
    expect(Math.abs(row.subscriptionEndedAt!.getTime() - E.getTime())).toBeLessThan(1000);
    expect(row.deletionScheduledFor!.getTime() - row.subscriptionEndedAt!.getTime()).toBe(90 * 86_400_000);
    expect(mode(row)).toBe('read_only');
    expect((await noticesOf(tenant.id)).map((n) => n.kind)).toContain('subscription-ended');
    await post(subEvent('customer.subscription.deleted', customer, s, 'canceled'));
    const again = await getTenantRow(tenant.id);
    expect(again.subscriptionEndedAt!.getTime()).toBe(row.subscriptionEndedAt!.getTime());
    expect(again.deletionScheduledFor!.getTime()).toBe(row.deletionScheduledFor!.getTime());
  });

  it('canceled after our own termination is a no-op (E and D never move)', async () => {
    const E = daysFrom(NOW, -2);
    const D = daysFrom(NOW, 88);
    const s = stripeState.addSub(customer, 'canceled', { endedAt: daysFrom(NOW, -1) });
    await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(NOW, -90), subscriptionEndedAt: E, deletionScheduledFor: D });
    await post(subEvent('customer.subscription.deleted', customer, s, 'canceled'));
    const row = await getTenantRow(tenant.id);
    expect(row.subscriptionEndedAt!.getTime()).toBe(E.getTime());
    expect(row.deletionScheduledFor!.getTime()).toBe(D.getTime());
  });

  it('DUNNING after termination only mirrors the status (no grace restart, no notice)', async () => {
    const s = stripeState.addSub(customer, 'past_due');
    await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'canceled', firstGoodAt: daysFrom(NOW, -90), subscriptionEndedAt: daysFrom(NOW, -2), deletionScheduledFor: daysFrom(NOW, 88) });
    await post(invoiceEvent('invoice.payment_failed', customer, s));
    const row = await getTenantRow(tenant.id);
    expect(row.pastDueSince).toBeNull();
    expect((await noticesOf(tenant.id)).filter((n) => n.kind === 'payment-failed')).toHaveLength(0);
  });

  it('a policy suspension survives invoice.paid and a cancellation (alert, no export-window email)', async () => {
    const s = stripeState.addSub(customer, 'active');
    await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -90), status: 'suspended', suspendedAt: daysFrom(NOW, -1), suspensionReason: 'policy' });
    await post(invoiceEvent('invoice.paid', customer, s));
    let row = await getTenantRow(tenant.id);
    expect(row.status).toBe('suspended');
    expect(row.suspensionReason).toBe('policy');
    stripeState.setSub(s, { status: 'canceled', ended_at: sec(new Date()) });
    await post(subEvent('customer.subscription.deleted', customer, s, 'canceled'));
    row = await getTenantRow(tenant.id);
    expect(row.status).toBe('suspended');
    expect((await noticesOf(tenant.id)).map((n) => n.kind)).not.toContain('subscription-ended');
    expect((await openAlertsOf(tenant.id)).map((a) => a.kind)).toContain('policy-suspended-subscription-ended');
  });

  it('a basil-shaped invoice event (subscription under parent.subscription_details) is processed, not ignored', async () => {
    const s = stripeState.addSub(customer, 'active');
    await setTenant(tenant.id, {
      stripeSubscriptionId: s, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(NOW, -90), pastDueSince: daysFrom(NOW, -3),
    });
    const res = await post(event('invoice.paid', {
      id: 'in_basil', object: 'invoice', customer,
      parent: { type: 'subscription_details', subscription_details: { subscription: s } },
    }));
    expect(((await res.json()) as { ignored?: boolean }).ignored).toBeUndefined();
    const row = await getTenantRow(tenant.id);
    expect(row.subscriptionStatus).toBe('active');
    expect(row.pastDueSince).toBeNull();
  });

  it('a one-off invoice (no subscription) is ignored without reading Stripe', async () => {
    const res = await post(invoiceEvent('invoice.paid', customer, null));
    expect(res.status).toBe(200);
    expect(stripeState.calls).toHaveLength(0);
  });

  it('invoice.paid on a canceled subscription → alert', async () => {
    const s = stripeState.addSub(customer, 'canceled', { endedAt: daysFrom(NOW, -10) });
    await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'canceled', firstGoodAt: daysFrom(NOW, -90), subscriptionEndedAt: daysFrom(NOW, -10), deletionScheduledFor: daysFrom(NOW, 80) });
    await post(invoiceEvent('invoice.paid', customer, s));
    expect((await openAlertsOf(tenant.id)).map((a) => a.kind)).toContain('invoice-paid-non-live');
  });

  it('paused → alert, no grace', async () => {
    const s = stripeState.addSub(customer, 'paused');
    await setTenant(tenant.id, { stripeSubscriptionId: s, firstGoodAt: daysFrom(NOW, -30), subscriptionStatus: 'active' });
    await post(subEvent('customer.subscription.updated', customer, s, 'paused'));
    const row = await getTenantRow(tenant.id);
    expect(row.pastDueSince).toBeNull();
    expect((await openAlertsOf(tenant.id)).map((a) => a.kind)).toContain('paused-subscription');
  });

  it('lost subscription.deleted + a new incomplete checkout still records the old cancellation', async () => {
    const E = daysFrom(NOW, -10);
    const old = stripeState.addSub(customer, 'canceled', { endedAt: E, created: daysFrom(NOW, -100) });
    await setTenant(tenant.id, { stripeSubscriptionId: old, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -100) });
    const fresh = stripeState.addSub(customer, 'incomplete', { created: new Date() });
    await post(subEvent('customer.subscription.created', customer, fresh, 'incomplete'));
    const row = await getTenantRow(tenant.id);
    expect(Math.abs(row.subscriptionEndedAt!.getTime() - E.getTime())).toBeLessThan(1000);
    expect(mode(row)).toBe('read_only');
  });

  it('cancel_at_period_end stays full while active, then read_only once it ends', async () => {
    const s = stripeState.addSub(customer, 'active');
    await post(subEvent('customer.subscription.updated', customer, s)); // cancel scheduled: still active
    expect(mode(await getTenantRow(tenant.id))).toBe('full');
    stripeState.setSub(s, { status: 'canceled', ended_at: sec(new Date()) });
    await post(subEvent('customer.subscription.deleted', customer, s, 'canceled'));
    expect(mode(await getTenantRow(tenant.id))).toBe('read_only');
  });

  it('customer.deleted before subscription.deleted → read_only; the customer id is kept', async () => {
    const s = stripeState.addSub(customer, 'active');
    await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -60) });
    stripeState.customers.get(customer)!.deleted = true;
    stripeState.setSub(s, { status: 'canceled', ended_at: sec(new Date()) });
    await post(event('customer.deleted', { id: customer, object: 'customer', deleted: true }));
    const row = await getTenantRow(tenant.id);
    expect(row.stripeCustomerId).toBe(customer);
    expect(row.stripeCustomerDeletedAt).not.toBeNull();
    expect(row.subscriptionEndedAt).not.toBeNull();
    expect(mode(row)).toBe('read_only');
  });

  it('checkout links the customer by slug and captures the billing email', async () => {
    await setTenant(tenant.id, { stripeCustomerId: null });
    const fresh = stripeState.addCustomer();
    const s = stripeState.addSub(fresh, 'active');
    await post(event('checkout.session.completed', {
      id: 'cs_1', object: 'checkout.session', customer: fresh, metadata: { slug: tenant.slug },
      customer_details: { email: 'pay@test.dev' }, subscription: s,
    }));
    const row = await getTenantRow(tenant.id);
    expect(row.stripeCustomerId).toBe(fresh);
    expect(row.billingEmail).toBe('pay@test.dev');
    expect(row.stripeSubscriptionId).toBe(s);
  });

  it('checkout never overwrites a live customer link (conflict alert)', async () => {
    const other = stripeState.addCustomer();
    await post(event('checkout.session.completed', { id: 'cs_2', object: 'checkout.session', customer: other, metadata: { slug: tenant.slug } }));
    const row = await getTenantRow(tenant.id);
    expect(row.stripeCustomerId).toBe(customer);
    expect((await openAlertsOf(tenant.id)).map((a) => a.kind)).toContain('checkout-customer-conflict');
  });

  it('checkout replaces a DELETED customer (audited) and re-subscribing ends full', async () => {
    await setTenant(tenant.id, { stripeCustomerDeletedAt: daysFrom(NOW, -5), firstGoodAt: daysFrom(NOW, -90), subscriptionEndedAt: daysFrom(NOW, -5), deletionScheduledFor: daysFrom(NOW, 85) });
    const fresh = stripeState.addCustomer();
    const s = stripeState.addSub(fresh, 'active');
    await post(event('checkout.session.completed', { id: 'cs_3', object: 'checkout.session', customer: fresh, metadata: { slug: tenant.slug } }));
    const row = await getTenantRow(tenant.id);
    expect(row.stripeCustomerId).toBe(fresh);
    expect(row.stripeCustomerDeletedAt).toBeNull();
    expect(row.stripeSubscriptionId).toBe(s);
    expect(mode(row)).toBe('full');
    expect((await auditOf(tenant.id)).map((e) => e.kind)).toContain('stripe-customer-replaced');
  });

  it('an event for an old customer replaced by checkout is ignored', async () => {
    const old = customer;
    const fresh = stripeState.addCustomer();
    await setTenant(tenant.id, { stripeCustomerId: fresh });
    stripeState.customers.get(old)!.deleted = true;
    const res = await post(event('customer.deleted', { id: old, object: 'customer', deleted: true }));
    expect(res.status).toBe(200);
    const row = await getTenantRow(tenant.id);
    expect(row.stripeCustomerId).toBe(fresh);
    expect(row.stripeCustomerDeletedAt).toBeNull();
  });

  it('customer.updated keeps the billing email current (only when non-null)', async () => {
    await post(event('customer.updated', { id: customer, object: 'customer', email: 'new-billing@test.dev' }));
    expect((await getTenantRow(tenant.id)).billingEmail).toBe('new-billing@test.dev');
    await post(event('customer.updated', { id: customer, object: 'customer', email: null }));
    expect((await getTenantRow(tenant.id)).billingEmail).toBe('new-billing@test.dev');
  });

  it('a deleting tenant with a LIVE subscription → alert, no fact writes', async () => {
    const s = stripeState.addSub(customer, 'active');
    const before = await setTenant(tenant.id, { status: 'deleting' });
    await post(subEvent('customer.subscription.updated', customer, s));
    const row = await getTenantRow(tenant.id);
    expect(row.lifecycleVersion).toBe(before.lifecycleVersion);
    expect(row.stripeSubscriptionId).toBeNull();
    expect((await openAlertsOf(tenant.id)).map((a) => a.kind)).toContain('live-subscription-on-closed-tenant');
  });

  it('lock timeout → 503 (Stripe retries); nothing written', async () => {
    const s = stripeState.addSub(customer, 'active');
    const holder = postgres(process.env.CONTROL_PLANE_DATABASE_URL!, { max: 1 });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const holding = holder.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + tenant.id}))`;
      await released;
    });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const res = await post(subEvent('customer.subscription.created', customer, s));
      expect(res.status).toBe(503);
      expect((await getTenantRow(tenant.id)).stripeSubscriptionId).toBeNull();
    } finally {
      release();
      await holding;
      await holder.end();
    }
  });

  it('an inline notice delivery failure never turns the webhook into a 500 (left for the cron)', async () => {
    const s = stripeState.addSub(customer, 'past_due');
    resendState.script = ['throw'];
    const res = await post(invoiceEvent('invoice.payment_failed', customer, s));
    expect(res.status).toBe(200);
    expect(afterTasks.length).toBe(1);
    await afterTasks[0](); // delivery errors are swallowed inside the after() task (a throw here fails the test)
    const notice = (await noticesOf(tenant.id)).find((n) => n.kind === 'payment-failed')!;
    expect(notice.sentAt).toBeNull();
    expect(notice.lastError).toBeTruthy();
  });

  it('a Stripe read failure returns 500 so Stripe retries (never "no subscriptions")', async () => {
    stripeState.failures.set('subscriptions.list', Object.assign(new Error('Invalid API key'), { code: 'api_key_invalid' }));
    const res = await post(subEvent('customer.subscription.updated', customer, 'sub_y'));
    expect(res.status).toBe(500);
    expect((await getTenantRow(tenant.id)).lifecycleVersion).toBe(tenant.lifecycleVersion);
  });

  it('resource_missing for a NON-deleted customer (wrong key / test-live mismatch) fails instead of reading empty', async () => {
    const s = stripeState.addSub(customer, 'active');
    await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -30) });
    stripeState.failures.set('subscriptions.list', Object.assign(new Error('No such customer'), { code: 'resource_missing' }));
    const res = await post(subEvent('customer.subscription.updated', customer, s));
    expect(res.status).toBe(500);
    expect((await getTenantRow(tenant.id)).subscriptionEndedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// feature-plan-per-user-billing.md §6.5, §6.9 — S11, S16, S23 (webhook half), S33 (webhook half), S38
// ---------------------------------------------------------------------------

describe.skipIf(!cpReady)('Stripe webhook: per-user billing (§6.9)', () => {
  let customer: string;
  let tenant: TenantRow;

  beforeEach(async () => {
    stripeState.reset();
    resendState.reset();
    afterTasks.length = 0;
    setNoticeTimingForTests({ sendTimeoutMs: 200, backoffBaseMs: 5, throttleMs: 0 });
    await cleanupTestData();
    await cleanupLifecycleTenants();
    await createTestUser({ role: 'admin', isActive: true });
    customer = stripeState.addCustomer();
    tenant = await makeTenant({ stripeCustomerId: customer });
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
    await cleanupTestData();
    const { controlDb } = await import('@/db/control-plane');
    const { opsAlerts } = await import('@/db/control-plane/schema');
    const { and, eq } = await import('drizzle-orm');
    await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.scope, 'global'), eq(opsAlerts.kind, 'stripe-event-unknown-customer')));
  });

  const seatDue = async (tenantId: string) => {
    const { controlDb } = await import('@/db/control-plane');
    const { tenantSeatBilling } = await import('@/db/control-plane/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await controlDb.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, tenantId));
    return row?.syncDueAt ?? null;
  };
  const failedInvoice = (sub: string, created = new Date()) =>
    event('invoice.payment_failed', { id: `in_${Math.random().toString(36).slice(2)}`, object: 'invoice', customer, subscription: sub, created: sec(created) });
  const session = (type: string, sub: string | null, created = new Date()) =>
    event(type, { id: `cs_${Math.random().toString(36).slice(2)}`, object: 'checkout.session', customer, subscription: sub, metadata: { slug: tenant.slug }, created: sec(created), customer_details: null });
  const notices = async (kind: string) => (await noticesOf(tenant.id)).filter((n) => n.kind === kind);
  const alerts = async (kind: string) => (await openAlertsOf(tenant.id)).filter((a) => a.kind === kind);

  it('S16: invoice.payment_failed on a GOOD charge-automatically subscription → bank-payment-failed (anchor invoice.created) and an alert', async () => {
    const s = stripeState.addSub(customer, 'active');
    tenant = await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(new Date(), -40) });
    const created = new Date(Date.now() - 3_600_000);
    const e = failedInvoice(s, created);
    expect((await post(e)).status).toBe(200);
    const n = await notices('bank-payment-failed');
    expect(n).toHaveLength(1);
    expect(n[0].scheduledFor.getTime()).toBe(sec(created) * 1000);
    expect((await alerts('payment-failed-subscription-active')).map((a) => a.dedupKey)).toEqual([(e.data.object as { id: string }).id]);
    expect(await notices('payment-failed')).toEqual([]);
  });

  it('S16: on past_due → only the existing payment-failed', async () => {
    const s = stripeState.addSub(customer, 'past_due');
    tenant = await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(new Date(), -40) });
    await post(failedInvoice(s));
    expect(await notices('payment-failed')).toHaveLength(1);
    expect(await notices('bank-payment-failed')).toEqual([]);
    expect(await alerts('payment-failed-subscription-active')).toEqual([]);
  });

  it('S16 / S38: checkout.session.async_payment_failed with the subscription incomplete → exactly one bank-payment-failed (anchor session.created) and an alert; the invoice event adds none', async () => {
    const s = stripeState.addSub(customer, 'incomplete');
    const created = new Date(Date.now() - 7_200_000);
    expect((await post(session('checkout.session.async_payment_failed', s, created))).status).toBe(200);
    const n = await notices('bank-payment-failed');
    expect(n).toHaveLength(1);
    expect(n[0].scheduledFor.getTime()).toBe(sec(created) * 1000);
    expect(await alerts('checkout-payment-failed')).toHaveLength(1);
    await post(failedInvoice(s)); // its invoice's failure: the subscription isn't LIVE → nothing more
    expect(await notices('bank-payment-failed')).toHaveLength(1);
  });

  it('S16: async_payment_failed with the subscription GOOD → the alert only (the invoice event sends the email)', async () => {
    const s = stripeState.addSub(customer, 'active');
    await post(session('checkout.session.async_payment_failed', s));
    expect(await alerts('checkout-payment-failed')).toHaveLength(1);
    expect(await notices('bank-payment-failed')).toEqual([]);
  });

  it('S38 (Q11): invoice.payment_failed on a GOOD send_invoice subscription → bank-payment-failed; the same invoice again → no second notice; with pastDueSince set → none', async () => {
    const s = stripeState.addSub(customer, 'active', { collection_method: 'send_invoice' });
    stripeState.addInvoice(customer, s, { due_date: sec(daysFrom(new Date(), 20)), created: sec(new Date()) });
    tenant = await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', collectionMethod: 'send_invoice', firstGoodAt: daysFrom(new Date(), -40) });
    const created = new Date(Date.now() - 600_000);
    const e = failedInvoice(s, created);
    await post(e);
    await post({ ...e, id: `evt_${Math.random().toString(36).slice(2)}` }); // a second event for the same invoice
    const n = await notices('bank-payment-failed');
    expect(n).toHaveLength(1);
    expect(n[0].scheduledFor.getTime()).toBe(sec(created) * 1000);

    // pastDueSince set (an overdue invoice): payment-failed covers it, no bank-payment-failed.
    const other = stripeState.addCustomer();
    const s2 = stripeState.addSub(other, 'past_due', { collection_method: 'send_invoice' });
    stripeState.addInvoice(other, s2, { due_date: sec(daysFrom(new Date(), -2)), created: sec(daysFrom(new Date(), -32)) });
    const t2 = await makeTenant({ stripeCustomerId: other, stripeSubscriptionId: s2, subscriptionStatus: 'past_due', collectionMethod: 'send_invoice', firstGoodAt: daysFrom(new Date(), -40) });
    await post(event('invoice.payment_failed', { id: 'in_t2', object: 'invoice', customer: other, subscription: s2, created: sec(new Date()) }));
    const kindsT2 = (await noticesOf(t2.id)).map((x) => x.kind);
    expect(kindsT2).toContain('payment-failed');
    expect(kindsT2).not.toContain('bank-payment-failed');
  });

  it('S16: an event for a customer no workspace is linked to → stripe-event-unknown-customer (founder alert)', async () => {
    const { controlDb } = await import('@/db/control-plane');
    const { opsAlerts } = await import('@/db/control-plane/schema');
    const { and, eq, isNull } = await import('drizzle-orm');
    const res = await post(subEvent('customer.subscription.created', 'cus_unlinked_42', 'sub_x'));
    expect(await res.json()).toMatchObject({ ignored: true });
    const open = await controlDb.select().from(opsAlerts)
      .where(and(eq(opsAlerts.scope, 'global'), eq(opsAlerts.kind, 'stripe-event-unknown-customer'), isNull(opsAlerts.resolvedAt)));
    expect(open.map((a) => [a.dedupKey, (a.detail as { event: string }).event])).toEqual([['cus_unlinked_42', 'customer.subscription.created']]);
  });

  it('S16 / S33: checkout.session.completed, async_payment_succeeded and customer.subscription.created mark the seat sync due; customer.updated doesn\'t', async () => {
    const s = stripeState.addSub(customer, 'active');
    await post(session('checkout.session.completed', s));
    expect(await seatDue(tenant.id)).not.toBeNull();

    for (const make of [
      () => session('checkout.session.async_payment_succeeded', s),
      (t: TenantRow) => subEvent('customer.subscription.created', t.stripeCustomerId!, s),
    ]) {
      await cleanupLifecycleTenants();
      customer = stripeState.addCustomer();
      stripeState.setSub(s, { customer });
      tenant = await makeTenant({ stripeCustomerId: customer });
      expect((await post(make(tenant))).status).toBe(200);
      expect(await seatDue(tenant.id)).not.toBeNull();
    }

    await cleanupLifecycleTenants();
    customer = stripeState.addCustomer();
    tenant = await makeTenant({ stripeCustomerId: customer });
    await post(event('customer.updated', { id: customer, object: 'customer', email: 'pay@x.test' }));
    expect(await seatDue(tenant.id)).toBeNull();
  });

  it('S11: Stripe past_due while the mirror says active → the seat sync is not-applicable, no update, drift raised; back to active via the webhook → marked due, drift resolved', async () => {
    process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_month';
    const s = stripeState.addSub(customer, 'past_due', { priceId: 'price_std_month', quantity: 1 });
    tenant = await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(new Date(), -40), plan: 'standard' });
    const { syncSeatQuantity } = await import('@/lib/billing/seat-sync');
    expect((await syncSeatQuantity(tenant.id, { runId: 'r', reason: 'daily' })).outcome).toBe('not-applicable');
    expect(stripeState.updates).toEqual([]);
    expect((await alerts('subscription-status-drift')).map((a) => a.dedupKey)).toEqual([s]);

    stripeState.setSub(s, { status: 'active' });
    await post(subEvent('customer.subscription.updated', customer, s));
    expect(await alerts('subscription-status-drift')).toEqual([]);
    expect(await seatDue(tenant.id)).toBeNull(); // GOOD → GOOD: no becameGood

    // A real recovery: the mirror past_due, Stripe active → becameGood → marked due.
    stripeState.setSub(s, { status: 'past_due' });
    await post(subEvent('customer.subscription.updated', customer, s));
    stripeState.setSub(s, { status: 'active' });
    await post(subEvent('customer.subscription.updated', customer, s));
    expect(await seatDue(tenant.id)).not.toBeNull();
  });

  it('M10: a revival (ended → not ended) with the mirror already GOOD reports becameGood and marks the seat sync due', async () => {
    const s = stripeState.addSub(customer, 'active');
    tenant = await setTenant(tenant.id, {
      stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(new Date(), -100),
      subscriptionEndedAt: daysFrom(new Date(), -3), deletionScheduledFor: daysFrom(new Date(), 87),
    });
    await post(subEvent('customer.subscription.updated', customer, s));
    expect((await getTenantRow(tenant.id)).subscriptionEndedAt).toBeNull();
    expect(await seatDue(tenant.id)).toBeInstanceOf(Date);
  });

  it('M11: invoice.payment_failed for an ENDED tenant whose subscription is still LIVE → the founder alert only, no bank-payment-failed', async () => {
    const s = stripeState.addSub(customer, 'past_due'); // DUNNING after the end: status only, pastDueSince stays null
    tenant = await setTenant(tenant.id, {
      stripeSubscriptionId: s, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(new Date(), -100),
      subscriptionEndedAt: daysFrom(new Date(), -3), deletionScheduledFor: daysFrom(new Date(), 87),
    });
    await post(failedInvoice(s));
    const row = await getTenantRow(tenant.id);
    expect(row.subscriptionEndedAt).not.toBeNull();
    expect(row.pastDueSince).toBeNull();
    expect(await notices('bank-payment-failed')).toEqual([]);
    expect(await alerts('payment-failed-subscription-active')).toHaveLength(1);
  });

  it('M11b: the bank-payment-failed email is delivered with the Q6 subject', async () => {
    const s = stripeState.addSub(customer, 'active');
    tenant = await setTenant(tenant.id, { stripeSubscriptionId: s, subscriptionStatus: 'active', firstGoodAt: daysFrom(new Date(), -40) });
    await post(failedInvoice(s));
    for (const task of afterTasks.splice(0)) await task();
    expect(resendState.delivered.map((c) => c.subject)).toEqual([`Payment not received for ${tenant.name}`]);
  });

  it('S23 (webhook half): a webhook for a deleting tenant writes no facts and marks nothing', async () => {
    const s = stripeState.addSub(customer, 'active');
    tenant = await setTenant(tenant.id, { status: 'deleting' });
    await post(subEvent('customer.subscription.created', customer, s));
    expect(await seatDue(tenant.id)).toBeNull();
    expect((await getTenantRow(tenant.id)).stripeSubscriptionId).toBeNull();
  });
});
