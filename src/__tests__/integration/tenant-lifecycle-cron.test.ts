import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import postgres from 'postgres';
import { and, eq, isNull, sql } from 'drizzle-orm';

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);

import { controlDb } from '@/db/control-plane';
import { opsAlerts, tenants } from '@/db/control-plane/schema';
import { runLifecycleCron, runTenantLifecycle } from '@/lib/tenant/lifecycle-runner';
import { deliverPendingNotices, setNoticeTimingForTests } from '@/lib/tenant/notices';
import { getTenantAccess } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { stripeState } from './fakes/fake-stripe';
import { resendState } from './fakes/fake-resend';
import { cleanupTestData, createTestUser } from './helpers';
import {
  cpReady, cleanupLifecycleTenants, daysFrom, getTenantRow, insertNotice, makeTenant, noticesOf, observationsOf,
  openAlertsOf, setTenant, type TenantRow,
} from './lifecycle-helpers';

/**
 * feature-plan-terms-compliance-fixes.md §4.4 / §7 "Cron": the daily lifecycle run, driven with an injected clock.
 * Stripe and Resend are in-memory fakes; the control plane and tenant DB are real.
 */

const HOUR = 3_600_000;
const later = (base: Date, days: number, hours = 0) => new Date(base.getTime() + days * 86_400_000 + hours * HOUR);
const kinds = async (tenantId: string) => (await noticesOf(tenantId)).map((n) => n.kind).sort();
const sentKinds = async (tenantId: string) => (await noticesOf(tenantId)).filter((n) => n.sentAt).map((n) => n.kind).sort();
const alertKinds = async (tenantId: string) => (await openAlertsOf(tenantId)).map((a) => a.kind);
const mode = (row: TenantRow, at: Date) => getTenantAccess(toLifecycleFacts(row), at);

describe.skipIf(!cpReady)('tenant lifecycle cron (§4.4)', () => {
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

  /** A paying tenant in dunning since P with a past_due subscription in Stripe. */
  async function dunningTenant(P: Date, o: Partial<typeof tenants.$inferInsert> = {}) {
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    const tenant = await makeTenant({
      stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due',
      firstGoodAt: daysFrom(P, -60), pastDueSince: P, currentPeriodEnd: daysFrom(NOW, 10), ...o,
    });
    return { tenant, customer, sub };
  }

  describe('trial', () => {
    it('only the nearest reminder is sent', async () => {
      const t = await makeTenant({ trialEndsAt: later(NOW, 0, 12) });
      await runTenantLifecycle(t.id, NOW);
      expect(await kinds(t.id)).toEqual(['trial-reminder-1d']); // the 7-day one is never even enqueued
      expect(await sentKinds(t.id)).toEqual(['trial-reminder-1d']);
    });

    it('a converted tenant never gets trial notices', async () => {
      const customer = stripeState.addCustomer();
      const sub = stripeState.addSub(customer, 'active');
      const t = await makeTenant({
        trialEndsAt: later(NOW, 3), stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'active',
        firstGoodAt: daysFrom(NOW, -1), currentPeriodEnd: daysFrom(NOW, 29),
      });
      await runTenantLifecycle(t.id, NOW);
      await runTenantLifecycle(t.id, later(NOW, 3, 1));
      expect(await kinds(t.id)).toEqual([]);
      expect(mode(await getTenantRow(t.id), later(NOW, 3, 1))).toBe('full');
    });

    it('ends on schedule even when no reminder could be delivered (read_only at T, alert raised)', async () => {
      const T = later(NOW, 5);
      const t = await makeTenant({ trialEndsAt: T });
      resendState.enabled = false;
      await runTenantLifecycle(t.id, NOW); // 7-day reminder: undeliverable
      expect(await sentKinds(t.id)).toEqual([]);
      const atT = later(NOW, 5, 1);
      await runTenantLifecycle(t.id, atT);
      const row = await getTenantRow(t.id);
      expect(mode(row, atT)).toBe('read_only');
      expect(row.deletionScheduledFor!.getTime()).toBe(daysFrom(T, 90).getTime());
      expect(await alertKinds(t.id)).toContain('undeliverable-notice');
      // Email back: the reminder that can no longer be useful is superseded (never sent late), and that raises
      // the dedicated alert (F4).
      resendState.enabled = true;
      await deliverPendingNotices(10_000, atT, [t.id]);
      expect((await noticesOf(t.id)).find((n) => n.kind === 'trial-reminder-7d')!.sentAt).toBeNull();
      await runTenantLifecycle(t.id, later(NOW, 5, 2));
      expect(await alertKinds(t.id)).toContain('undeliverable-trial-reminder');
    });

    it('a missing trial date raises an alert (never silently free) and stays full', async () => {
      const t = await makeTenant({ trialEndsAt: null });
      await runTenantLifecycle(t.id, NOW);
      expect(await alertKinds(t.id)).toContain('missing-trial-date');
      expect(mode(await getTenantRow(t.id), NOW)).toBe('full');
      await setTenant(t.id, { trialEndsAt: later(NOW, 10) });
      await runTenantLifecycle(t.id, NOW);
      expect(await alertKinds(t.id)).not.toContain('missing-trial-date'); // auto-resolved
    });

    it('exempt tenants are untouched', async () => {
      const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -40), lifecycleExempt: true });
      const res = await runTenantLifecycle(t.id, NOW);
      expect(res.outcome).toBe('ok');
      const row = await getTenantRow(t.id);
      expect(row.deletionScheduledFor).toBeNull();
      expect(await kinds(t.id)).toEqual([]);
      expect(mode(row, NOW)).toBe('full');
    });
  });

  describe('dunning → suspension (after notice)', () => {
    it('suspends only after the warning was sent and 3 more days passed; states the real date', async () => {
      const P = daysFrom(NOW, -13);
      const { tenant } = await dunningTenant(P);
      await runTenantLifecycle(tenant.id, NOW); // P+13d: warning
      const warning = (await noticesOf(tenant.id)).find((n) => n.kind === 'suspension-warning')!;
      expect(warning.sentAt).not.toBeNull();
      expect((await getTenantRow(tenant.id)).status).toBe('active');

      await runTenantLifecycle(tenant.id, later(NOW, 2, 1)); // past P+15d, but < warning + 3d
      expect((await getTenantRow(tenant.id)).status).toBe('active');

      const at = later(NOW, 3, 1);
      await runTenantLifecycle(tenant.id, at);
      const row = await getTenantRow(tenant.id);
      expect(row.status).toBe('suspended');
      expect(row.suspensionReason).toBe('nonpayment');
      expect(row.suspendedAt!.getTime()).toBe(at.getTime());
      expect(mode(row, at)).toBe('billing_only');
      expect(await sentKinds(tenant.id)).toContain('suspended');
    });

    it('an ACH payment processing defers suspension; a 3-D Secure wait does not', async () => {
      const P = daysFrom(NOW, -20);
      const { tenant, customer, sub } = await dunningTenant(P);
      await insertNotice(tenant.id, 'suspension-warning', (await getTenantRow(tenant.id)).pastDueSince!, { sentAt: daysFrom(NOW, -6), providerMessageId: 'msg_x' });
      const inv = stripeState.addInvoice(customer, sub, { piStatus: 'processing' });
      await runTenantLifecycle(tenant.id, NOW);
      expect((await getTenantRow(tenant.id)).status).toBe('active');
      expect((await observationsOf(tenant.id)).map((o) => o.kind)).toContain('processing');

      stripeState.invoices.get(inv)!.piStatus = 'requires_action';
      stripeState.invoices.get(inv)!.piNextAction = 'use_stripe_sdk'; // card 3DS the customer ignores
      await runTenantLifecycle(tenant.id, later(NOW, 0, 1));
      expect((await getTenantRow(tenant.id)).status).toBe('suspended');
    });

    it('microdeposit verification defers for at most 10 days (cumulative per invoice)', async () => {
      const P = daysFrom(NOW, -20);
      const { tenant, customer, sub } = await dunningTenant(P);
      await insertNotice(tenant.id, 'suspension-warning', (await getTenantRow(tenant.id)).pastDueSince!, { sentAt: daysFrom(NOW, -6), providerMessageId: 'msg_x' });
      stripeState.addInvoice(customer, sub, { piStatus: 'requires_action', piNextAction: 'verify_with_microdeposits' });
      await runTenantLifecycle(tenant.id, NOW);
      expect((await getTenantRow(tenant.id)).status).toBe('active');
      await runTenantLifecycle(tenant.id, later(NOW, 9));
      expect((await getTenantRow(tenant.id)).status).toBe('active');
      await runTenantLifecycle(tenant.id, later(NOW, 10, 1));
      expect((await getTenantRow(tenant.id)).status).toBe('suspended');
    });

    it('reconcile skips suspension when Stripe says the customer paid (lost invoice.paid)', async () => {
      const P = daysFrom(NOW, -20);
      const { tenant, sub } = await dunningTenant(P);
      await insertNotice(tenant.id, 'suspension-warning', (await getTenantRow(tenant.id)).pastDueSince!, { sentAt: daysFrom(NOW, -6), providerMessageId: 'msg_x' });
      stripeState.setSub(sub, { status: 'active' });
      await runTenantLifecycle(tenant.id, NOW);
      const row = await getTenantRow(tenant.id);
      expect(row.status).toBe('active');
      expect(row.pastDueSince).toBeNull();
      expect(mode(row, NOW)).toBe('full');
    });

    it('a µs-precision past_due_since written by SQL still warns and suspends (no timestamp-equality guards)', async () => {
      const { tenant } = await dunningTenant(daysFrom(NOW, -13));
      await controlDb.execute(sql`UPDATE tenants SET past_due_since = now() - interval '13 days 1.234567 seconds' WHERE id = ${tenant.id}`);
      await runTenantLifecycle(tenant.id, NOW);
      await runTenantLifecycle(tenant.id, later(NOW, 3, 1));
      expect((await getTenantRow(tenant.id)).status).toBe('suspended');
    });

    it('a policy suspension in dunning keeps reason=policy (never re-suspended, never terminated)', async () => {
      const { tenant } = await dunningTenant(daysFrom(NOW, -40), { status: 'suspended', suspendedAt: daysFrom(NOW, -35), suspensionReason: 'policy' });
      await runTenantLifecycle(tenant.id, NOW);
      const row = await getTenantRow(tenant.id);
      expect(row.suspensionReason).toBe('policy');
      expect(row.subscriptionEndedAt).toBeNull();
    });
  });

  describe('suspended → termination (D9)', () => {
    async function suspendedTenant(daysSuspended: number) {
      const Sa = daysFrom(NOW, -daysSuspended);
      const d = await dunningTenant(daysFrom(Sa, -16), { status: 'suspended', suspendedAt: Sa, suspensionReason: 'nonpayment' });
      return { ...d, Sa: (await getTenantRow(d.tenant.id)).suspendedAt! };
    }

    it('waits for the "suspended" notice; blocked-transition alert after 2 days undeliverable', async () => {
      const { tenant, Sa } = await suspendedTenant(31);
      await insertNotice(tenant.id, 'suspended', Sa, { createdAt: daysFrom(NOW, -3) });
      resendState.enabled = false;
      await runTenantLifecycle(tenant.id, NOW);
      let row = await getTenantRow(tenant.id);
      expect(row.subscriptionEndedAt).toBeNull();
      expect(await alertKinds(tenant.id)).toContain('blocked-transition');
      expect(row.suspendedAt!.getTime()).toBe(Sa.getTime()); // never re-suspended

      resendState.enabled = true;
      await deliverPendingNotices(10_000, NOW, [tenant.id]);
      await runTenantLifecycle(tenant.id, later(NOW, 0, 1));
      row = await getTenantRow(tenant.id);
      expect(row.subscriptionEndedAt).not.toBeNull();
      expect(await alertKinds(tenant.id)).not.toContain('blocked-transition');
    });

    it('terminates: read_only with D = now + 90 d, cancels the subscription, voids open invoices', async () => {
      const { tenant, customer, sub, Sa } = await suspendedTenant(31);
      await insertNotice(tenant.id, 'suspended', Sa, { sentAt: daysFrom(NOW, -31), providerMessageId: 'msg_s' });
      const inv = stripeState.addInvoice(customer, sub, { piStatus: 'requires_payment_method' });
      const res = await runTenantLifecycle(tenant.id, NOW);
      expect(res.terminated).toBe(true);
      const row = await getTenantRow(tenant.id);
      expect(row.status).toBe('active');
      expect(row.suspensionReason).toBeNull();
      expect(row.deletionScheduledFor!.getTime()).toBe(daysFrom(NOW, 90).getTime());
      expect(mode(row, NOW)).toBe('read_only');
      expect(stripeState.subs.get(sub)!.status).toBe('canceled');
      expect(stripeState.invoices.get(inv)!.status).toBe('void');
      expect(await alertKinds(tenant.id)).not.toContain('pending-invoice-void');
      expect(await sentKinds(tenant.id)).toContain('subscription-ended');

      await runTenantLifecycle(tenant.id, later(NOW, 1)); // no re-suspension after termination
      expect((await getTenantRow(tenant.id)).status).toBe('active');
    });

    it('defers termination while an ACH payment is processing on a NON-latest open invoice', async () => {
      const { tenant, customer, sub, Sa } = await suspendedTenant(31);
      await insertNotice(tenant.id, 'suspended', Sa, { sentAt: daysFrom(NOW, -31), providerMessageId: 'msg_s' });
      stripeState.addInvoice(customer, sub, { id: 'in_a_old', piStatus: 'processing' });
      stripeState.addInvoice(customer, sub, { id: 'in_b_new', piStatus: 'requires_payment_method' });
      stripeState.pageSize = 1; // forces has_more pagination
      await runTenantLifecycle(tenant.id, NOW);
      expect((await getTenantRow(tenant.id)).subscriptionEndedAt).toBeNull();
    });

    it('a cancel failure raises an alert, counts as a failure, and is retried next run', async () => {
      const { tenant, sub, Sa } = await suspendedTenant(31);
      await insertNotice(tenant.id, 'suspended', Sa, { sentAt: daysFrom(NOW, -31), providerMessageId: 'msg_s' });
      stripeState.failures.set('subscriptions.cancel', new Error('stripe down'));
      const first = await runTenantLifecycle(tenant.id, NOW);
      expect(first.outcome).toBe('failed');
      expect(await alertKinds(tenant.id)).toContain('stripe-cancel-failure');
      expect((await getTenantRow(tenant.id)).lifecycleFailures).toBe(1);
      stripeState.failures.delete('subscriptions.cancel');
      await runTenantLifecycle(tenant.id, later(NOW, 1));
      expect(stripeState.subs.get(sub)!.status).toBe('canceled');
      expect(await alertKinds(tenant.id)).not.toContain('stripe-cancel-failure');
      expect((await getTenantRow(tenant.id)).lifecycleFailures).toBe(0);
    });

    it('reconcile skips termination when Stripe says the customer paid (restored to full)', async () => {
      const { tenant, sub, Sa } = await suspendedTenant(31);
      await insertNotice(tenant.id, 'suspended', Sa, { sentAt: daysFrom(NOW, -31), providerMessageId: 'msg_s' });
      stripeState.setSub(sub, { status: 'active' });
      const res = await runTenantLifecycle(tenant.id, NOW);
      expect(res.terminated).toBe(false);
      const row = await getTenantRow(tenant.id);
      expect(row.subscriptionEndedAt).toBeNull();
      expect(row.status).toBe('active');
      expect(mode(row, NOW)).toBe('full');
    });

    it('the per-subscription cancel is skipped while a payment starts processing on that subscription', async () => {
      const { tenant, customer, sub, Sa } = await suspendedTenant(31);
      await insertNotice(tenant.id, 'suspended', Sa, { sentAt: daysFrom(NOW, -31), providerMessageId: 'msg_s' });
      // Between the evaluation and the cancel section, the customer starts an ACH payment.
      stripeState.hooks.set('subscriptions.retrieve', () => { stripeState.addInvoice(customer, sub, { piStatus: 'processing' }); });
      await runTenantLifecycle(tenant.id, NOW);
      expect(stripeState.subs.get(sub)!.status).toBe('past_due'); // never cancelled mid-payment
    });

    it('the per-subscription cancel is skipped if the subscription turned GOOD meanwhile', async () => {
      const { tenant, sub, Sa } = await suspendedTenant(31);
      await insertNotice(tenant.id, 'suspended', Sa, { sentAt: daysFrom(NOW, -31), providerMessageId: 'msg_s' });
      stripeState.hooks.set('subscriptions.retrieve', () => stripeState.setSub(sub, { status: 'active' }));
      await runTenantLifecycle(tenant.id, NOW);
      expect(stripeState.subs.get(sub)!.status).toBe('active');
      const row = await getTenantRow(tenant.id);
      expect(row.subscriptionEndedAt).toBeNull(); // GOOD transition applied in the cancel section
      expect(mode(row, NOW)).toBe('full');
    });
  });

  describe('reconcile repairs', () => {
    it('lost subscription.deleted is caught via a stale current_period_end', async () => {
      const customer = stripeState.addCustomer();
      const E = daysFrom(NOW, -3);
      const sub = stripeState.addSub(customer, 'canceled', { endedAt: E });
      const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -90), currentPeriodEnd: daysFrom(NOW, -3) });
      await runTenantLifecycle(t.id, NOW);
      const row = await getTenantRow(t.id);
      expect(row.subscriptionEndedAt).not.toBeNull();
      expect(mode(row, NOW)).toBe('read_only');
    });

    it('lost invoice.payment_failed is caught via a stale current_period_end', async () => {
      const customer = stripeState.addCustomer();
      const sub = stripeState.addSub(customer, 'past_due');
      const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -90), currentPeriodEnd: daysFrom(NOW, -2) });
      await runTenantLifecycle(t.id, NOW);
      expect((await getTenantRow(t.id)).pastDueSince).not.toBeNull();
    });

    it('canceled-but-not-ended mirror is repaired', async () => {
      const customer = stripeState.addCustomer();
      const sub = stripeState.addSub(customer, 'canceled', { endedAt: daysFrom(NOW, -1) });
      const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'canceled', firstGoodAt: daysFrom(NOW, -90) });
      await runTenantLifecycle(t.id, NOW);
      expect((await getTenantRow(t.id)).subscriptionEndedAt).not.toBeNull();
    });

    it('lost incomplete→active is caught', async () => {
      const customer = stripeState.addCustomer();
      const sub = stripeState.addSub(customer, 'active');
      const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'incomplete' });
      await runTenantLifecycle(t.id, NOW);
      const row = await getTenantRow(t.id);
      expect(row.subscriptionStatus).toBe('active');
      expect(row.firstGoodAt).not.toBeNull();
    });
  });

  describe('retention window → deletion readiness', () => {
    async function endedTenant(E: Date, D: Date) {
      const customer = stripeState.addCustomer();
      const sub = stripeState.addSub(customer, 'canceled', { endedAt: E });
      const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'canceled', firstGoodAt: daysFrom(E, -100), subscriptionEndedAt: E, deletionScheduledFor: D });
      return { t, E: (await getTenantRow(t.id)).subscriptionEndedAt! };
    }

    it('deletion notice, D pushed to ≥ notice + 14 d, final reminder, then ready (D4: never auto-deleted)', async () => {
      const { t } = await endedTenant(daysFrom(NOW, -80), daysFrom(NOW, 10));
      await runTenantLifecycle(t.id, NOW);
      expect(await sentKinds(t.id)).toContain('deletion-notice');
      const notice = (await noticesOf(t.id)).find((n) => n.kind === 'deletion-notice')!;
      const D = (await getTenantRow(t.id)).deletionScheduledFor!;
      expect(D.getTime()).toBeGreaterThanOrEqual(daysFrom(notice.sentAt!, 14).getTime());

      await runTenantLifecycle(t.id, later(D, -3, 1));
      expect(await sentKinds(t.id)).toContain('deletion-final-reminder');

      const res = await runTenantLifecycle(t.id, later(D, 0, 1));
      expect(res.readyForDeletion).toBeTruthy();
      expect(res.readyForDeletion!.overdue).toBe(false);
      expect((await getTenantRow(t.id)).status).toBe('active'); // listed, never deleted automatically

      const overdue = await runTenantLifecycle(t.id, later(D, 8));
      expect(overdue.readyForDeletion!.overdue).toBe(true);
    });

    it('a deletion notice for an OLD anchor never makes the workspace ready', async () => {
      const { t } = await endedTenant(daysFrom(NOW, -95), daysFrom(NOW, -1));
      await insertNotice(t.id, 'deletion-notice', daysFrom(NOW, -400), { sentAt: daysFrom(NOW, -30), providerMessageId: 'msg_old' });
      const res = await runTenantLifecycle(t.id, NOW);
      expect(res.readyForDeletion).toBeUndefined();
    });

    it('readiness is withheld while a payment is processing', async () => {
      const { t, E } = await endedTenant(daysFrom(NOW, -95), daysFrom(NOW, -1));
      await insertNotice(t.id, 'deletion-notice', E, { sentAt: daysFrom(NOW, -20), providerMessageId: 'msg_dn' });
      const row = await getTenantRow(t.id);
      stripeState.addInvoice(row.stripeCustomerId!, null, { piStatus: 'processing' });
      const res = await runTenantLifecycle(t.id, NOW);
      expect(res.readyForDeletion).toBeUndefined();
      expect(res.blockedDeletion).toBe('payment activity');
    });

    it('readiness is withheld while a subscription is incomplete ("blocked: payment activity")', async () => {
      const { t, E } = await endedTenant(daysFrom(NOW, -95), daysFrom(NOW, -1));
      await insertNotice(t.id, 'deletion-notice', E, { sentAt: daysFrom(NOW, -20), providerMessageId: 'msg_dn' });
      const row = await getTenantRow(t.id);
      stripeState.addSub(row.stripeCustomerId!, 'incomplete', { created: new Date() });
      const res = await runTenantLifecycle(t.id, NOW);
      expect(res.readyForDeletion).toBeUndefined();
      expect(res.blockedDeletion).toBe('payment activity');
    });
  });

  describe('payment-pending observations', () => {
    it('pending-payment alert after 10 days processing; auto-resolves (and the row is deleted) once the invoice closes', async () => {
      const { tenant, customer, sub } = await dunningTenant(daysFrom(NOW, -5));
      const inv = stripeState.addInvoice(customer, sub, { piStatus: 'processing' });
      await runTenantLifecycle(tenant.id, NOW);
      await runTenantLifecycle(tenant.id, later(NOW, 11));
      expect(await alertKinds(tenant.id)).toContain('pending-payment');
      stripeState.invoices.get(inv)!.status = 'paid';
      await runTenantLifecycle(tenant.id, later(NOW, 12));
      expect(await alertKinds(tenant.id)).not.toContain('pending-payment');
      expect(await observationsOf(tenant.id)).toHaveLength(0);
    });

    it('no false alert after an ACH payment fails on an invoice that stays open', async () => {
      const { tenant, customer, sub } = await dunningTenant(daysFrom(NOW, -5));
      const inv = stripeState.addInvoice(customer, sub, { piStatus: 'processing' });
      await runTenantLifecycle(tenant.id, NOW);
      stripeState.invoices.get(inv)!.piStatus = 'requires_payment_method';
      await runTenantLifecycle(tenant.id, later(NOW, 11));
      expect(await alertKinds(tenant.id)).not.toContain('pending-payment');
      expect((await observationsOf(tenant.id)).filter((o) => o.kind === 'processing')).toHaveLength(0);
    });

    it('resolving the alert by hand does not restart the microdeposit window', async () => {
      const { tenant, customer, sub } = await dunningTenant(daysFrom(NOW, -20));
      await insertNotice(tenant.id, 'suspension-warning', (await getTenantRow(tenant.id)).pastDueSince!, { sentAt: daysFrom(NOW, -6), providerMessageId: 'msg_x' });
      stripeState.addInvoice(customer, sub, { piStatus: 'requires_action', piNextAction: 'verify_with_microdeposits' });
      await runTenantLifecycle(tenant.id, NOW);
      await controlDb.update(opsAlerts).set({ resolvedAt: new Date() }).where(and(eq(opsAlerts.scope, tenant.id), isNull(opsAlerts.resolvedAt)));
      await runTenantLifecycle(tenant.id, later(NOW, 10, 1));
      expect((await getTenantRow(tenant.id)).status).toBe('suspended');
    });
  });

  describe('failures, rotation, budget', () => {
    it('3 failed runs in a row raise "tenant lifecycle failing"; success resets the counter and resolves it', async () => {
      const { tenant } = await dunningTenant(daysFrom(NOW, -5));
      stripeState.failures.set('subscriptions.list', new Error('stripe down'));
      for (let i = 1; i <= 3; i++) {
        const r = await runTenantLifecycle(tenant.id, later(NOW, 0, i));
        expect(r.outcome).toBe('failed');
      }
      let row = await getTenantRow(tenant.id);
      expect(row.lifecycleFailures).toBe(3);
      expect(row.lifecycleCheckedAt).not.toBeNull(); // set even on failure
      expect(await alertKinds(tenant.id)).toContain('tenant-lifecycle-failing');
      stripeState.failures.delete('subscriptions.list');
      await runTenantLifecycle(tenant.id, later(NOW, 0, 4));
      row = await getTenantRow(tenant.id);
      expect(row.lifecycleFailures).toBe(0);
      expect(await alertKinds(tenant.id)).not.toContain('tenant-lifecycle-failing');
    });

    it('a lock-timeout skip counts as a failure', async () => {
      const t = await makeTenant({ trialEndsAt: later(NOW, 3) });
      const holder = postgres(process.env.CONTROL_PLANE_DATABASE_URL!, { max: 1 });
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const holding = holder.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + t.id}))`;
        await released;
      });
      try {
        await new Promise((r) => setTimeout(r, 200));
        const res = await runTenantLifecycle(t.id, NOW);
        expect(res.outcome).toBe('lock-timeout');
        expect((await getTenantRow(t.id)).lifecycleFailures).toBe(1);
      } finally {
        release();
        await holding;
        await holder.end();
      }
    });

    it('version retries are capped at 3, then the run fails with an alert', async () => {
      const { tenant } = await dunningTenant(daysFrom(NOW, -5));
      // Something outside the lock bumps the version during every attempt.
      stripeState.hooks.set('subscriptions.list', () => {
        void controlDb.update(tenants).set({ lifecycleVersion: sql`${tenants.lifecycleVersion} + 1` }).where(eq(tenants.id, tenant.id)).then(() => {});
      });
      stripeState.delays.set('subscriptions.list', 150);
      const res = await runTenantLifecycle(tenant.id, NOW);
      expect(res.outcome).toBe('failed');
      expect(stripeState.calls.filter((c) => c === 'subscriptions.list')).toHaveLength(3);
      expect(await alertKinds(tenant.id)).toContain('lifecycle-version-conflict');
    });

    it('the time budget stops cleanly (incomplete-run alert) and the next run starts with the oldest-checked', async () => {
      const a = await makeTenant({ trialEndsAt: later(NOW, 20) });
      const b = await makeTenant({ trialEndsAt: later(NOW, 20) });
      const first = await runLifecycleCron({ budgetMs: 0, onlyTenantIds: [a.id, b.id], requireEmail: false });
      expect(first.incomplete).toBe(true);
      expect(first.results).toHaveLength(1);
      const done = first.results[0].slug;
      const second = await runLifecycleCron({ budgetMs: 60_000, onlyTenantIds: [a.id, b.id], requireEmail: false });
      expect(second.incomplete).toBe(false);
      expect(second.results[0].slug).not.toBe(done); // the never-checked tenant goes first
      const open = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.kind, 'cron-incomplete-run'), isNull(opsAlerts.resolvedAt)));
      expect(open).toHaveLength(0); // a complete run resolves it
    });

    it('email disabled → one deduplicated alert every run; resolved when re-enabled', async () => {
      resendState.enabled = false;
      await runLifecycleCron({ budgetMs: 60_000, onlyTenantIds: [], requireEmail: true });
      await runLifecycleCron({ budgetMs: 60_000, onlyTenantIds: [], requireEmail: true });
      let open = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.kind, 'email-disabled'), isNull(opsAlerts.resolvedAt)));
      expect(open).toHaveLength(1);
      expect(open[0].occurrences).toBeGreaterThanOrEqual(2);
      resendState.enabled = true;
      await runLifecycleCron({ budgetMs: 60_000, onlyTenantIds: [], requireEmail: true });
      open = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.kind, 'email-disabled'), isNull(opsAlerts.resolvedAt)));
      expect(open).toHaveLength(0);
    });
  });
});
