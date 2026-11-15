import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const state = vi.hoisted(() => {
  process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_month';
  process.env.STRIPE_PRICE_STANDARD_ANNUAL = 'price_std_year';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.OPS_ALERT_EMAIL = 'ops@cadenzpoint.test';
  return { slug: '' };
});

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: () => {}, // notices are delivered by the lifecycle runs below
}));
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
    getTenantForBilling: async () => {
      invalidateTenant(state.slug);
      const t = await getTenantBySlug(state.slug);
      if (!t || (t.status !== 'active' && t.status !== 'suspended')) throw new Error('This workspace is not available.');
      return t;
    },
  };
});

import { controlDb } from '@/db/control-plane';
import { tenantSeatBilling, tenants } from '@/db/control-plane/schema';
import { POST } from '@/app/api/stripe/webhook/route';
import { runTenantLifecycle } from '@/lib/tenant/lifecycle-runner';
import { deliverPendingNotices, setNoticeTimingForTests } from '@/lib/tenant/notices';
import { runSeatSyncCron, seatSyncCandidates, syncSeatQuantity } from '@/lib/billing/seat-sync';
import { getTenantBillingInfo } from '@/server/actions/billing';
import { paymentTile } from '@/app/(app)/settings/billing/BillingClient';
import { stripeState } from './fakes/fake-stripe';
import { resendState } from './fakes/fake-resend';
import { cleanupTestData, createTestUser } from './helpers';
import {
  cpReady, cleanupLifecycleTenants, getTenantRow, insertNotice, makeTenant, noticesOf, openAlertsOf, setTenant,
} from './lifecycle-helpers';

/**
 * feature-plan-per-user-billing.md §6.2, §6.4 step 8, §6.7, §7.3 send-invoice walk-through: invoiced (send_invoice)
 * subscriptions follow their invoices' due dates, not Stripe's status. Stripe and Resend are fakes; the control plane
 * and tenant DB are real. Time moves by passing `now` to the lifecycle run.
 */

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const DAY = 86_400_000;
const at = (base: Date, days: number, hours = 0) => new Date(base.getTime() + days * DAY + hours * 3_600_000);
const evt = (type: string, object: Record<string, unknown>) => ({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, created: sec(new Date()), data: { object } });
async function post(e: ReturnType<typeof evt>): Promise<Response> {
  return POST(new Request('http://test.localhost/api/stripe/webhook', { method: 'POST', body: JSON.stringify(e), headers: { 'stripe-signature': 'valid' } }) as never);
}
const kinds = async (tenantId: string) => (await noticesOf(tenantId)).map((n) => n.kind).sort();
const subjects = () => resendState.delivered.map((c) => c.subject);

describe.skipIf(!cpReady)('invoiced (send_invoice) subscriptions (§6.2, §6.7)', () => {
  const NOW = new Date();

  beforeEach(async () => {
    stripeState.reset();
    resendState.reset();
    setNoticeTimingForTests({ sendTimeoutMs: 200, backoffBaseMs: 5, throttleMs: 0 });
    await cleanupTestData();
    await cleanupLifecycleTenants();
    await createTestUser({ role: 'admin', isActive: true });
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
    await cleanupTestData();
  });

  /** A founder-made send_invoice Standard subscription on the workspace's own customer. */
  async function invoicedTenant(o: { status?: string; interval?: 'month' | 'year'; quantity?: number; tenant?: Partial<typeof tenants.$inferInsert> } = {}) {
    const customer = stripeState.addCustomer();
    const interval = o.interval ?? 'month';
    const sub = stripeState.addSub(customer, o.status ?? 'active', {
      priceId: interval === 'year' ? 'price_std_year' : 'price_std_month', interval, quantity: o.quantity ?? 1,
      collection_method: 'send_invoice', periodEnd: at(NOW, 20),
    });
    const tenant = await makeTenant({
      stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: o.status ?? 'active', collectionMethod: 'send_invoice',
      firstGoodAt: at(NOW, -60), currentPeriodEnd: at(NOW, 20), plan: 'standard', trialEndsAt: at(NOW, -90), ...o.tenant,
    });
    state.slug = tenant.slug;
    return { tenant, customer, sub };
  }
  const invoice = (customer: string, sub: string, due: Date | null, o: Record<string, unknown> = {}) =>
    stripeState.addInvoice(customer, sub, { due_date: due ? sec(due) : null, created: sec(at(due ?? NOW, -30)), hosted_invoice_url: `https://pay.test/${Math.random().toString(36).slice(2, 8)}`, ...o });

  it('S10a: send_invoice on the linked customer, invoice open and not yet due → GOOD, Standard from day one, no grace', async () => {
    const customer = stripeState.addCustomer();
    const tenant = await makeTenant({ stripeCustomerId: customer });
    const sub = stripeState.addSub(customer, 'active', { priceId: 'price_std_year', interval: 'year', collection_method: 'send_invoice' });
    invoice(customer, sub, at(NOW, 30));
    expect((await post(evt('customer.subscription.created', { id: sub, object: 'subscription', customer, status: 'active' }))).status).toBe(200);
    const row = await getTenantRow(tenant.id);
    expect(row).toMatchObject({ stripeSubscriptionId: sub, subscriptionStatus: 'active', plan: 'standard', planInterval: 'year', collectionMethod: 'send_invoice', pastDueSince: null });
    expect(row.firstGoodAt).not.toBeNull();
    expect(await kinds(tenant.id)).toEqual([]);
  });

  it('S10b: past due with an older invoice overdue 3 days and a newer one not yet due → P = the older due date, the invoiced email, payUrl = the older invoice', async () => {
    const { tenant, customer, sub } = await invoicedTenant();
    const olderDue = at(NOW, -3);
    const older = invoice(customer, sub, olderDue, { hosted_invoice_url: 'https://pay.test/older' });
    invoice(customer, sub, at(NOW, 27), { hosted_invoice_url: 'https://pay.test/newer', billing_reason: 'subscription_update', created: sec(at(NOW, -1)) });
    stripeState.setSub(sub, { status: 'past_due' });
    await post(evt('customer.subscription.updated', { id: sub, object: 'subscription', customer, status: 'past_due' }));
    const row = await getTenantRow(tenant.id);
    expect(row.pastDueSince?.getTime()).toBe(sec(olderDue) * 1000);
    const n = (await noticesOf(tenant.id)).find((x) => x.kind === 'payment-failed')!;
    expect(n.scheduledFor.getTime()).toBe(sec(olderDue) * 1000);
    await deliverPendingNotices(10_000, NOW, [tenant.id]); // the delivery cron (the webhook's after() is stubbed here)
    expect(subjects()).toContain(`Invoice overdue for ${tenant.name}`);
    expect(subjects().some((s) => s.startsWith('Payment failed'))).toBe(false);
    const info = await getTenantBillingInfo();
    expect(info.payUrl).toBe('https://pay.test/older');
    expect(info.overdue).toBe(true);
    expect(stripeState.invoices.get(older)!.status).toBe('open');
  });

  it('S10c / S10d: at due + 12 the warning, at due + 15 suspended; paid → unsuspended', async () => {
    const { tenant, customer, sub } = await invoicedTenant();
    const due = at(NOW, -1);
    const inv = invoice(customer, sub, due);
    stripeState.setSub(sub, { status: 'past_due' });
    await runTenantLifecycle(tenant.id, NOW);
    const P = (await getTenantRow(tenant.id)).pastDueSince!;
    expect(P.getTime()).toBe(sec(due) * 1000);
    await runTenantLifecycle(tenant.id, at(P, 12, 1));
    expect((await noticesOf(tenant.id)).find((n) => n.kind === 'suspension-warning')!.sentAt).toBeInstanceOf(Date);
    expect((await getTenantRow(tenant.id)).status).toBe('active');
    const r = await runTenantLifecycle(tenant.id, at(P, 15, 2));
    expect(r.suspended).toBe(true);
    expect((await getTenantRow(tenant.id))).toMatchObject({ status: 'suspended', suspensionReason: 'nonpayment' });

    stripeState.invoices.get(inv)!.status = 'paid';
    stripeState.setSub(sub, { status: 'active' });
    await runTenantLifecycle(tenant.id, at(P, 16));
    expect(await getTenantRow(tenant.id)).toMatchObject({ status: 'active', suspendedAt: null, suspensionReason: null, pastDueSince: null });
  });

  it('S10e: a lost past_due webhook is found by the daily run (anchored on the due date); Stripe active with an overdue invoice → the same anchor, suspension at due + 15; a second run keeps the same suspension', async () => {
    const lost = await invoicedTenant();
    const due = at(NOW, -2);
    invoice(lost.customer, lost.sub, due);
    stripeState.setSub(lost.sub, { status: 'past_due' }); // the mirror still says active: no event arrived
    await runTenantLifecycle(lost.tenant.id, NOW);
    expect((await getTenantRow(lost.tenant.id)).pastDueSince?.getTime()).toBe(sec(due) * 1000);

    const active = await invoicedTenant();
    const oldDue = at(NOW, -2);
    invoice(active.customer, active.sub, oldDue);
    stripeState.addInvoice(active.customer, active.sub, { status: 'paid', due_date: sec(at(NOW, -1)), created: sec(at(NOW, -1)) }); // the newer one, paid
    await runTenantLifecycle(active.tenant.id, NOW);
    const P = (await getTenantRow(active.tenant.id)).pastDueSince!;
    expect(P.getTime()).toBe(sec(oldDue) * 1000);
    expect(subjects()).toContain(`Invoice overdue for ${active.tenant.name}`);
    await runTenantLifecycle(active.tenant.id, at(P, 12, 1));
    await runTenantLifecycle(active.tenant.id, at(P, 15, 2));
    const suspended = await getTenantRow(active.tenant.id);
    expect(suspended.status).toBe('suspended');
    const before = (await noticesOf(active.tenant.id)).filter((n) => n.kind === 'suspended');
    await runTenantLifecycle(active.tenant.id, at(P, 16));
    const after = await getTenantRow(active.tenant.id);
    expect(after.status).toBe('suspended');
    expect(after.suspendedAt?.getTime()).toBe(suspended.suspendedAt!.getTime());
    expect((await noticesOf(active.tenant.id)).filter((n) => n.kind === 'suspended')).toHaveLength(before.length);
  });

  it('S39: Stripe past_due before any invoice is due → no grace, "Invoice open", the seat sync still syncs; a failed attempt → bank-payment-failed; after the due date → P and the invoiced email', async () => {
    const { tenant, customer, sub } = await invoicedTenant({ status: 'past_due', quantity: 1 });
    const due = at(NOW, 10);
    const inv = invoice(customer, sub, due);
    await post(evt('customer.subscription.updated', { id: sub, object: 'subscription', customer, status: 'past_due' }));
    let row = await getTenantRow(tenant.id);
    expect(row.pastDueSince).toBeNull();
    expect(await kinds(tenant.id)).toEqual([]);
    expect(paymentTile(await getTenantBillingInfo()).big).toBe('Invoice open');
    await createTestUser({ isActive: true }); // 2 active users
    expect((await syncSeatQuantity(tenant.id, { runId: 'r', reason: 'due' })).outcome).toBe('updated');
    expect(stripeState.subs.get(sub)!.quantity).toBe(2);

    await post(evt('invoice.payment_failed', { id: inv, object: 'invoice', customer, subscription: sub, created: sec(at(NOW, -1)) }));
    expect(await kinds(tenant.id)).toEqual(['bank-payment-failed']);

    await runTenantLifecycle(tenant.id, at(due, 0, 6));
    row = await getTenantRow(tenant.id);
    expect(row.pastDueSince?.getTime()).toBe(sec(due) * 1000);
    expect(subjects()).toContain(`Invoice overdue for ${tenant.name}`);
  });

  it('S42: invoice A overdue (suspended), then A paid while B is open and not yet due, Stripe still past_due → unsuspended, no warning, old notices superseded; variant: B overdue by a day → fresh grace from B', async () => {
    const { tenant, customer, sub } = await invoicedTenant({ status: 'past_due' });
    const aDue = at(NOW, -20);
    const a = invoice(customer, sub, aDue);
    const b = invoice(customer, sub, at(NOW, 5));
    await setTenant(tenant.id, { pastDueSince: new Date(sec(aDue) * 1000), status: 'suspended', suspendedAt: at(NOW, -4), suspensionReason: 'nonpayment' });
    await insertNotice(tenant.id, 'suspension-warning', new Date(sec(aDue) * 1000));
    stripeState.invoices.get(a)!.status = 'paid';
    await post(evt('invoice.paid', { id: a, object: 'invoice', customer, subscription: sub }));
    const row = await getTenantRow(tenant.id);
    expect(row).toMatchObject({ status: 'active', suspendedAt: null, pastDueSince: null, subscriptionStatus: 'past_due' });
    await deliverPendingNotices(10_000, NOW, [tenant.id]);
    const warning = (await noticesOf(tenant.id)).find((n) => n.kind === 'suspension-warning')!;
    expect(warning.supersededAt).not.toBeNull();
    expect(warning.sentAt).toBeNull();

    // Variant: B is overdue by 1 day when A is paid.
    const v = await invoicedTenant({ status: 'past_due' });
    const vaDue = at(NOW, -20);
    const va = invoice(v.customer, v.sub, vaDue);
    const bDue = at(NOW, -1);
    invoice(v.customer, v.sub, bDue);
    await setTenant(v.tenant.id, { pastDueSince: new Date(sec(vaDue) * 1000), status: 'suspended', suspendedAt: at(NOW, -4), suspensionReason: 'nonpayment' });
    stripeState.invoices.get(va)!.status = 'paid';
    await post(evt('invoice.paid', { id: va, object: 'invoice', customer: v.customer, subscription: v.sub }));
    const vr = await getTenantRow(v.tenant.id);
    expect(vr.status).toBe('active');
    expect(vr.pastDueSince?.getTime()).toBe(sec(bDue) * 1000);
    expect((await noticesOf(v.tenant.id)).some((n) => n.kind === 'payment-failed' && n.scheduledFor.getTime() === sec(bDue) * 1000)).toBe(true);
    const P = vr.pastDueSince!;
    await runTenantLifecycle(v.tenant.id, at(P, 12, 1));
    expect((await noticesOf(v.tenant.id)).find((n) => n.kind === 'suspension-warning' && n.scheduledFor.getTime() === P.getTime())!.sentAt).toBeInstanceOf(Date);
    expect((await runTenantLifecycle(v.tenant.id, at(P, 15, 2))).suspended).toBe(true);
    void b;
  });

  it('S44 / S45: an invoiced tenant terminated for an overdue invoice while Stripe says active → its subscription canceled once and invoices voided; the next run stays ended; no sync, no candidates, "Canceled"', async () => {
    const { tenant, customer, sub } = await invoicedTenant();
    const due = at(NOW, -46);
    const inv = invoice(customer, sub, due);
    const Sa = at(NOW, -31);
    await setTenant(tenant.id, { pastDueSince: new Date(sec(due) * 1000), status: 'suspended', suspendedAt: Sa, suspensionReason: 'nonpayment' });
    await insertNotice(tenant.id, 'suspended', Sa, { sentAt: Sa, providerMessageId: 'msg_x' });
    const r = await runTenantLifecycle(tenant.id, NOW);
    expect(r.terminated).toBe(true);
    expect(stripeState.subs.get(sub)!.status).toBe('canceled');
    expect(stripeState.calls.filter((c) => c === 'subscriptions.cancel')).toHaveLength(1); // toCancel de-duplicated
    expect(stripeState.invoices.get(inv)!.status).toBe('void');
    const ended = await getTenantRow(tenant.id);
    expect(ended.subscriptionEndedAt).not.toBeNull();
    const noticeCount = (await noticesOf(tenant.id)).length;

    await runTenantLifecycle(tenant.id, at(NOW, 1));
    const again = await getTenantRow(tenant.id);
    expect(again.subscriptionEndedAt?.getTime()).toBe(ended.subscriptionEndedAt!.getTime());
    expect((await noticesOf(tenant.id)).length).toBe(noticeCount);

    // S45 with Stripe still active (a cancel that hasn't happened yet): never revived, never synced.
    stripeState.setSub(sub, { status: 'active', ended_at: null });
    await runTenantLifecycle(tenant.id, at(NOW, 1, 1));
    expect((await getTenantRow(tenant.id)).subscriptionEndedAt).not.toBeNull();
    expect((await syncSeatQuantity(tenant.id, { runId: 'r', reason: 'due' })).outcome).toBe('not-applicable');
    expect((await seatSyncCandidates(new Date(), [tenant.id]))).toEqual([]);
    await setTenant(tenant.id, { subscriptionStatus: 'past_due' });
    expect(paymentTile(await getTenantBillingInfo()).big).toBe('Canceled');
  });

  it('S46: invoiced recovery while Stripe stays active (pastDueSince set → null) → becameGood marks the seat sync due', async () => {
    const { tenant, customer, sub } = await invoicedTenant();
    const inv = invoice(customer, sub, at(NOW, -2));
    await setTenant(tenant.id, { pastDueSince: at(NOW, -2) });
    stripeState.invoices.get(inv)!.status = 'paid';
    await post(evt('invoice.paid', { id: inv, object: 'invoice', customer, subscription: sub }));
    expect((await getTenantRow(tenant.id)).pastDueSince).toBeNull();
    const [seat] = await controlDb.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, tenant.id));
    expect(seat).toBeDefined();
    expect(seat.syncDueAt).toBeInstanceOf(Date);
  });

  it('S10f: annual send_invoice, users added → update, then finalize, send and the marker; a failed send → alert, the quantity still recorded; the next run sends it and the alert resolves; a lost update response still gets its invoice sent', async () => {
    const { tenant, customer, sub } = await invoicedTenant({ interval: 'year', quantity: 5 });
    for (let i = 0; i < 6; i++) await createTestUser({ isActive: true }); // 7 active (admin + 6)
    const draft = stripeState.addInvoice(customer, sub, { status: 'draft', billing_reason: 'subscription_update', created: sec(NOW) });
    stripeState.failures.set('invoices.sendInvoice', Object.assign(new Error('no email'), { type: 'StripeInvalidRequestError', code: 'email_invalid' }));
    const first = await syncSeatQuantity(tenant.id, { runId: 'r1', reason: 'due' });
    expect(first.outcome).toBe('updated');
    expect(stripeState.subs.get(sub)!.quantity).toBe(7);
    const seat = (await controlDb.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, tenant.id)))[0];
    expect(seat.stripeQuantity).toBe(7); // not blocked by step 8
    expect(seat.syncDueAt).not.toBeNull(); // step 8 re-marked it
    expect((await openAlertsOf(tenant.id)).map((a) => a.kind)).toContain('seat-sync-invoice-send-failed');
    expect(stripeState.invoices.get(draft)!.status).toBe('open'); // finalized with auto_advance false
    expect(stripeState.invoices.get(draft)!.auto_advance).toBe(false);

    stripeState.failures.clear();
    const second = await syncSeatQuantity(tenant.id, { runId: 'r2', reason: 'due' });
    expect(second.invoiceSent).toBe(draft);
    expect(stripeState.sentInvoices).toEqual([draft]);
    expect(stripeState.invoices.get(draft)!.metadata?.cadenzpoint_sent).toBeTruthy();
    expect((await openAlertsOf(tenant.id)).map((a) => a.kind)).not.toContain('seat-sync-invoice-send-failed');

    // A quantity update whose response is lost: the run fails, but its proration invoice is still found and sent.
    await createTestUser({ isActive: true });
    stripeState.failAfterApply.add('subscriptions.update');
    const lostInvoice = stripeState.addInvoice(customer, sub, { status: 'open', billing_reason: 'subscription_update', created: sec(NOW) + 5, auto_advance: false });
    const lost = await syncSeatQuantity(tenant.id, { runId: 'r3', reason: 'due' });
    expect(lost.outcome).toBe('failed');
    expect(stripeState.sentInvoices).toContain(lostInvoice);
  });

  it('S35: step 8 retries: a failed send, or two unsent invoices, leave the row due 10 minutes ahead; a manual run and the cron at once send once', async () => {
    const { tenant, customer, sub } = await invoicedTenant({ interval: 'year', quantity: 1 });
    stripeState.addInvoice(customer, sub, { status: 'open', billing_reason: 'subscription_update', created: sec(NOW) - 10, auto_advance: false });
    stripeState.addInvoice(customer, sub, { status: 'open', billing_reason: 'subscription_update', created: sec(NOW) - 5, auto_advance: false });
    const now = new Date();
    await syncSeatQuantity(tenant.id, { runId: 'a', reason: 'due', now });
    let seat = (await controlDb.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, tenant.id)))[0];
    expect(stripeState.sentInvoices).toHaveLength(1);
    expect(seat.syncDueAt).not.toBeNull();
    expect(Math.round((seat.nextAttemptAt!.getTime() - now.getTime()) / 60_000)).toBe(10);

    // Concurrent manual + cron: the second waits for the lock, then finds the invoice already marked.
    await Promise.all([
      syncSeatQuantity(tenant.id, { runId: 'manual', reason: 'manual' }),
      runSeatSyncCron({ onlyTenantIds: [tenant.id], now: () => at(now, 0, 1) }),
    ]);
    expect(stripeState.sentInvoices).toHaveLength(2);
    expect(new Set(stripeState.sentInvoices).size).toBe(2);
    seat = (await controlDb.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, tenant.id)))[0];
    expect(seat.syncDueAt).toBeNull();
  });
});
