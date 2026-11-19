import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);

import { controlDb } from '@/db/control-plane';
import {
  AdminCommandError, applyAdminPlan, findForceableNotice, forceNoticeSent, plans,
  recordFounderNote, recordProvisionTerms, resolveAlertById,
} from '@/lib/tenant/admin-commands';
import { runTenantLifecycle } from '@/lib/tenant/lifecycle-runner';
import { raiseAlert } from '@/lib/tenant/lifecycle-store';
import { deliverPendingNotices, resolveRecipientsAndTimezone, setNoticeTimingForTests } from '@/lib/tenant/notices';
import { calendarDayOf, formatCalendarDate } from '@/lib/calendar-date';
import { canExport, getTenantAccess } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { stripeState } from './fakes/fake-stripe';
import { resendState } from './fakes/fake-resend';
import { cleanupTestData, createTestUser } from './helpers';
import {
  cpReady, allAlertsOf, auditOf, cleanupLifecycleTenants, daysFrom, getTenantRow, insertNotice, makeTenant, noticesOf,
  openAlertsOf,
} from './lifecycle-helpers';

/** feature-plan-terms-compliance-fixes.md §5.6 / §7: founder commands — locked, version-guarded, audited. */

describe.skipIf(!cpReady)('tenant:admin commands (§5.6)', () => {
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

  it('extend-trial: T = max(now, T) + N, D cleared, version bumped, audited', async () => {
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -10), deletionScheduledFor: daysFrom(NOW, 80) });
    const after = await applyAdminPlan(t.id, plans.extendTrial(7), 'test');
    expect(after.trialEndsAt!.getTime()).toBeGreaterThanOrEqual(daysFrom(NOW, 7).getTime());
    expect(after.deletionScheduledFor).toBeNull();
    expect(after.lifecycleVersion).toBe(t.lifecycleVersion + 1);
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('trial-extended');
  });

  it('extend-trial refuses a subscribed or suspended workspace', async () => {
    const paid = await makeTenant({ firstGoodAt: daysFrom(NOW, -5), subscriptionStatus: 'active' });
    await expect(applyAdminPlan(paid.id, plans.extendTrial(7), 'test')).rejects.toThrow(AdminCommandError);
    const susp = await makeTenant({ status: 'suspended', suspendedAt: NOW, suspensionReason: 'policy' });
    await expect(applyAdminPlan(susp.id, plans.extendTrial(7), 'test')).rejects.toThrow(/suspended/);
  });

  it('extend-trial and a cron section serialize on the tenant lock (no lost update; D stays null)', async () => {
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -1) }); // lapsed: the cron would set D
    await Promise.all([
      runTenantLifecycle(t.id, new Date()),
      applyAdminPlan(t.id, plans.extendTrial(14), 'test'),
    ]);
    const row = await getTenantRow(t.id);
    expect(row.trialEndsAt!.getTime()).toBeGreaterThan(Date.now());
    if (row.deletionScheduledFor !== null) {
      // The cron ran first and set D; the extension (planned on the re-read row) must have cleared it.
      throw new Error('lost update: D survived the trial extension');
    }
  });

  it.each([['cron first'], ['extension first']])('extend-trial vs cron, %s: T extended and D null', async (order) => {
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -1) });
    if (order === 'cron first') {
      await runTenantLifecycle(t.id, new Date());
      expect((await getTenantRow(t.id)).deletionScheduledFor).not.toBeNull(); // the lapsed trial got a deletion date
      await applyAdminPlan(t.id, plans.extendTrial(14), 'test');
    } else {
      await applyAdminPlan(t.id, plans.extendTrial(14), 'test');
      await runTenantLifecycle(t.id, new Date());
    }
    const row = await getTenantRow(t.id);
    expect(row.trialEndsAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.deletionScheduledFor).toBeNull();
  });

  it('end-trial sets T = now', async () => {
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, 10) });
    const after = await applyAdminPlan(t.id, plans.endTrial(), 'test');
    expect(Math.abs(after.trialEndsAt!.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('policy suspend / unsuspend (audited); unsuspend refuses a non-payment suspension', async () => {
    const t = await makeTenant();
    const s = await applyAdminPlan(t.id, plans.suspend('abuse report #1'), 'test');
    expect(s.status).toBe('suspended');
    expect(s.suspensionReason).toBe('policy');
    const u = await applyAdminPlan(t.id, plans.unsuspend(), 'test');
    expect(u.status).toBe('active');
    expect(u.suspensionReason).toBeNull();
    expect((await auditOf(t.id)).map((e) => e.kind)).toEqual(expect.arrayContaining(['policy-suspended', 'policy-unsuspended']));
    const np = await makeTenant({ status: 'suspended', suspendedAt: NOW, suspensionReason: 'nonpayment' });
    await expect(applyAdminPlan(np.id, plans.unsuspend(), 'test')).rejects.toThrow(/policy suspension/);
  });

  it('F5 done-when: a policy hold blocks export and emails admins; set-policy-export on allows it and is logged', async () => {
    const t = await makeTenant({ firstGoodAt: daysFrom(NOW, -90), subscriptionStatus: 'active', billingEmail: 'billing@test.dev' });
    const held = await applyAdminPlan(t.id, plans.suspend('probing other tenants (ticket #7)'), 'founder:test');
    expect(getTenantAccess(toLifecycleFacts(held), new Date())).toBe('policy_hold');
    expect(canExport(toLifecycleFacts(held), new Date())).toBe(false);
    // §17.3: the admins' notice was enqueued with the suspension and is delivered.
    const notice = (await noticesOf(t.id)).find((n) => n.kind === 'policy-suspended')!;
    expect(notice.scheduledFor.getTime()).toBe(held.suspendedAt!.getTime());
    await deliverPendingNotices(10_000, undefined, [t.id]);
    expect((await noticesOf(t.id)).find((n) => n.kind === 'policy-suspended')!.sentAt).not.toBeNull();

    const allowed = await applyAdminPlan(t.id, plans.setPolicyExport(true, 'customer audit request, identity verified'), 'founder:test');
    expect(canExport(toLifecycleFacts(allowed), new Date())).toBe(true);
    const log = (await auditOf(t.id)).find((e) => e.kind === 'policy-export-allowed')!;
    expect(log.actor).toBe('founder:test');
    expect(log.detail).toContain('customer audit request');
    expect(log.createdAt).toBeTruthy();

    const blocked = await applyAdminPlan(t.id, plans.setPolicyExport(false, 'revoked'), 'founder:test');
    expect(canExport(toLifecycleFacts(blocked), new Date())).toBe(false);
    // Lifting the hold resets the allowance, so a later hold starts blocked again.
    await applyAdminPlan(t.id, plans.setPolicyExport(true, 'again'), 'founder:test');
    const lifted = await applyAdminPlan(t.id, plans.unsuspend(), 'founder:test');
    expect(lifted.policyExportAllowed).toBe(false);
    const again = await applyAdminPlan(t.id, plans.suspend('second incident'), 'founder:test');
    expect(again.policyExportAllowed).toBe(false);
  });

  // SWEEP-FINDINGS.md §5 A2-D1 (PO decision 3): no payment emails during a policy hold; they resume after unsuspend.
  // The revival lives in SQL (enqueueNotice's ON CONFLICT … WHERE sent_at IS NULL AND superseded_at IS NOT NULL).
  it('A2-D1: a pending payment-failed is superseded during a policy hold (never sent); after unsuspend the next run revives the SAME row and sends it once', async () => {
    const P = daysFrom(NOW, -5);
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    const t = await makeTenant({
      stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(P, -60),
      pastDueSince: P, currentPeriodEnd: daysFrom(NOW, 10), billingEmail: 'billing@test.dev',
    });
    const pendingRow = await insertNotice(t.id, 'payment-failed', P);
    const paymentEmails = () => resendState.delivered.filter((m) => m.subject.startsWith('Payment failed'));

    await applyAdminPlan(t.id, plans.suspend('A2-D1 test'), 'founder:test');
    await deliverPendingNotices(10_000, undefined, [t.id]);
    let pf = (await noticesOf(t.id)).filter((n) => n.kind === 'payment-failed');
    expect(pf).toHaveLength(1);
    expect(pf[0].supersededAt).not.toBeNull();
    expect(pf[0].sentAt).toBeNull();
    expect(resendState.delivered.map((m) => m.subject)).toEqual([expect.stringMatching(/is on hold$/)]); // policy-suspended only
    const generation = pf[0].idempotencyGeneration;

    // The daily run during the hold reconciles (still past_due) but queues nothing: the row stays superseded and is
    // never revived (a revival bumps the idempotency generation).
    await runTenantLifecycle(t.id, NOW);
    pf = (await noticesOf(t.id)).filter((n) => n.kind === 'payment-failed');
    expect(pf[0].supersededAt).not.toBeNull();
    expect(pf[0].idempotencyGeneration).toBe(generation);
    expect(paymentEmails()).toEqual([]);

    await applyAdminPlan(t.id, plans.unsuspend(), 'founder:test');
    // The next daily run (a day later: past the 10-minute claim lease the supersede attempt left on the row).
    const nextDay = daysFrom(new Date(), 1);
    await runTenantLifecycle(t.id, nextDay); // the reconcile queues it again
    pf = (await noticesOf(t.id)).filter((n) => n.kind === 'payment-failed');
    expect(pf).toHaveLength(1);
    expect(pf[0].id).toBe(pendingRow.id);
    expect(pf[0].supersededAt).toBeNull();
    expect(pf[0].sentAt).not.toBeNull();
    expect(paymentEmails()).toHaveLength(1);

    // Never re-sent by later runs.
    await runTenantLifecycle(t.id, daysFrom(nextDay, 1));
    expect(paymentEmails()).toHaveLength(1);
  });

  // N1 (lead, 2026-11-19): subscription-ended is held during a policy hold; unsuspend queues it again (both orders), and it
  // states the CURRENT deletion date, at least 14 days ahead (the deletion notice's push-at-render rule).
  describe('N1: subscription-ended during a policy hold', () => {
    const endedEmails = () => resendState.delivered.filter((m) => /subscription has ended$/.test(m.subject));
    const endedRows = async (id: string) => (await noticesOf(id)).filter((n) => n.kind === 'subscription-ended');

    it('ended BEFORE the hold: the pending email is superseded during the hold; after unsuspend the same row is sent, exactly once', async () => {
      const E = daysFrom(NOW, -10);
      const t = await makeTenant({ firstGoodAt: daysFrom(NOW, -200), subscriptionStatus: 'canceled', subscriptionEndedAt: E, deletionScheduledFor: daysFrom(E, 90), billingEmail: 'billing@test.dev' });
      const pendingRow = await insertNotice(t.id, 'subscription-ended', E);
      await applyAdminPlan(t.id, plans.suspend('N1 test'), 'founder:test');
      await deliverPendingNotices(10_000, undefined, [t.id]);
      expect((await endedRows(t.id))[0].supersededAt).not.toBeNull();
      expect(endedEmails()).toEqual([]);

      await applyAdminPlan(t.id, plans.unsuspend(), 'founder:test');
      // A delivery run after the 10-minute claim lease the supersede attempt left on the row.
      const afterLease = new Date(Date.now() + 11 * 60_000);
      await deliverPendingNotices(10_000, afterLease, [t.id]);
      const rows = await endedRows(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(pendingRow.id);
      expect(rows[0].sentAt).not.toBeNull();
      expect(endedEmails()).toHaveLength(1);
      await deliverPendingNotices(10_000, new Date(afterLease.getTime() + 11 * 60_000), [t.id]);
      expect(endedEmails()).toHaveLength(1);
    });

    it('ended DURING the hold: no email then (applyEnded under policy); after unsuspend exactly one is sent', async () => {
      const customer = stripeState.addCustomer();
      const sub = stripeState.addSub(customer, 'active');
      const t = await makeTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'active', firstGoodAt: daysFrom(NOW, -200), currentPeriodEnd: daysFrom(NOW, -3), billingEmail: 'billing@test.dev' });
      await applyAdminPlan(t.id, plans.suspend('N1 test'), 'founder:test');
      stripeState.subs.get(sub)!.status = 'canceled';
      stripeState.subs.get(sub)!.ended_at = Math.floor(daysFrom(NOW, -1).getTime() / 1000);
      await runTenantLifecycle(t.id, NOW); // the reconcile records the end; still held, no email queued
      const held = await getTenantRow(t.id);
      expect(held.subscriptionEndedAt).not.toBeNull();
      expect(held.suspensionReason).toBe('policy');
      expect(await endedRows(t.id)).toEqual([]);

      await applyAdminPlan(t.id, plans.unsuspend(), 'founder:test');
      await deliverPendingNotices(10_000, undefined, [t.id]);
      const rows = await endedRows(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].scheduledFor.getTime()).toBe(held.subscriptionEndedAt!.getTime());
      expect(rows[0].sentAt).not.toBeNull();
      expect(endedEmails()).toHaveLength(1);
      await runTenantLifecycle(t.id, NOW);
      await deliverPendingNotices(10_000, undefined, [t.id]);
      expect(endedEmails()).toHaveLength(1);
    });

    it('sent BEFORE the hold: unsuspend never re-sends it', async () => {
      const E = daysFrom(NOW, -10);
      const t = await makeTenant({ firstGoodAt: daysFrom(NOW, -200), subscriptionStatus: 'canceled', subscriptionEndedAt: E, deletionScheduledFor: daysFrom(E, 90), billingEmail: 'billing@test.dev' });
      const sentRow = await insertNotice(t.id, 'subscription-ended', E, { sentAt: daysFrom(NOW, -10), providerMessageId: 'msg_before' });
      await applyAdminPlan(t.id, plans.suspend('N1 test'), 'founder:test');
      await applyAdminPlan(t.id, plans.unsuspend(), 'founder:test');
      await deliverPendingNotices(10_000, undefined, [t.id]);
      const rows = await endedRows(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: sentRow.id, providerMessageId: 'msg_before', supersededAt: null, idempotencyGeneration: sentRow.idempotencyGeneration });
      expect(endedEmails()).toEqual([]);
    });

    it('a hold longer than 90 days: after unsuspend the email states a deletion date at least 14 days ahead, equal to deletion_scheduled_for', async () => {
      const E = daysFrom(NOW, -120);
      const t = await makeTenant({
        firstGoodAt: daysFrom(NOW, -400), subscriptionStatus: 'canceled', subscriptionEndedAt: E, deletionScheduledFor: daysFrom(E, 90), // 30 days ago
        status: 'suspended', suspendedAt: daysFrom(NOW, -119), suspensionReason: 'policy', billingEmail: 'billing@test.dev',
      });
      await applyAdminPlan(t.id, plans.unsuspend(), 'founder:test');
      const before = new Date();
      await deliverPendingNotices(10_000, undefined, [t.id]);
      const row = await getTenantRow(t.id);
      const D = row.deletionScheduledFor!;
      expect(D.getTime()).toBeGreaterThanOrEqual(daysFrom(before, 14).getTime());
      const [notice] = await endedRows(t.id);
      expect(notice.sentAt).not.toBeNull();
      const { timeZone } = await resolveRecipientsAndTimezone(row);
      const statedD = formatCalendarDate(calendarDayOf(D, timeZone), 'MMMM D, YYYY');
      expect((notice.payload as { stated: Record<string, string> }).stated.deletionDate).toBe(statedD);
      expect(endedEmails()).toHaveLength(1);
      expect(endedEmails()[0].html).toContain(statedD);
    });
  });

  it('set-policy-export refuses a workspace that is not on a policy hold', async () => {
    const np = await makeTenant({ status: 'suspended', suspendedAt: NOW, suspensionReason: 'nonpayment' });
    await expect(applyAdminPlan(np.id, plans.setPolicyExport(true, 'x'), 'test')).rejects.toThrow(/policy breach/);
    const active = await makeTenant();
    await expect(applyAdminPlan(active.id, plans.setPolicyExport(true, 'x'), 'test')).rejects.toThrow(/policy breach/);
  });

  it('set-exempt on: clears D and supersedes every pending notice', async () => {
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -100), deletionScheduledFor: daysFrom(NOW, -1) });
    const n = await insertNotice(t.id, 'deletion-notice', (await getTenantRow(t.id)).trialEndsAt!);
    const after = await applyAdminPlan(t.id, plans.setExempt(true, 'demo workspace'), 'test');
    expect(after.lifecycleExempt).toBe(true);
    expect(after.deletionScheduledFor).toBeNull();
    const notice = (await noticesOf(t.id)).find((x) => x.id === n.id)!;
    expect(notice.supersededAt).not.toBeNull();
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('exempt-on');
  });

  it('set-exempt off on an old ended workspace re-applies D, never in the past (≥ now + 14 d)', async () => {
    const t = await makeTenant({ lifecycleExempt: true, firstGoodAt: daysFrom(NOW, -500), subscriptionEndedAt: daysFrom(NOW, -400) });
    const after = await applyAdminPlan(t.id, plans.setExempt(false, 'no longer a demo'), 'test');
    expect(after.lifecycleExempt).toBe(false);
    expect(after.deletionScheduledFor!.getTime()).toBeGreaterThanOrEqual(daysFrom(NOW, 14).getTime() - 5000);
  });

  it('force-notice-sent: forced_at (never sent_at), audited, and it unblocks the waiting transition', async () => {
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    const Sa = daysFrom(NOW, -31);
    const t = await makeTenant({
      stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(NOW, -120),
      pastDueSince: daysFrom(NOW, -47), status: 'suspended', suspendedAt: Sa, suspensionReason: 'nonpayment',
    });
    const anchor = (await getTenantRow(t.id)).suspendedAt!;
    await insertNotice(t.id, 'suspended', anchor);
    resendState.enabled = false;
    await runTenantLifecycle(t.id, NOW);
    expect((await getTenantRow(t.id)).subscriptionEndedAt).toBeNull(); // blocked: notice never given

    const notice = await findForceableNotice(t.id, 'suspended');
    await forceNoticeSent(t.id, notice.id, 'delivered by phone, ticket #9', 'test');
    const forced = (await noticesOf(t.id)).find((n) => n.id === notice.id)!;
    expect(forced.forcedAt).not.toBeNull();
    expect(forced.sentAt).toBeNull();
    expect(forced.forcedAuditId).not.toBeNull();
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('force-notice-sent');

    await runTenantLifecycle(t.id, new Date(NOW.getTime() + 3_600_000));
    expect((await getTenantRow(t.id)).subscriptionEndedAt).not.toBeNull();
  });

  it('force-notice-sent refuses a missing or superseded notice', async () => {
    const t = await makeTenant();
    await expect(findForceableNotice(t.id, 'suspended')).rejects.toThrow(/No non-superseded/);
    await insertNotice(t.id, 'trial-ended', (await getTenantRow(t.id)).trialEndsAt!, { supersededAt: NOW });
    await expect(findForceableNotice(t.id, 'trial-ended')).rejects.toThrow(/No non-superseded/);
  });

  it('resolve-alert resolves once (bookkeeping only)', async () => {
    const t = await makeTenant();
    await raiseAlert(controlDb, { tenantId: t.id, kind: 'paused-subscription', dedupKey: 'sub_1' }, NOW);
    const [alert] = await allAlertsOf(t.id);
    await resolveAlertById(alert.id, 'handled in Stripe', 'test');
    await expect(resolveAlertById(alert.id, 'again', 'test')).rejects.toThrow(/Already resolved/);
  });

  it('resolve-alert refuses the disaster kinds (rebuild-*, disaster-*): they close only on the facts (feature-plan-disaster-restore.md §6.8)', async () => {
    const t = await makeTenant();
    for (const kind of ['rebuild-original-watch', 'rebuild-original-returned', 'disaster-rehearse-failed']) {
      await raiseAlert(controlDb, { tenantId: t.id, kind, dedupKey: `prj-${kind}` }, NOW);
    }
    for (const a of await allAlertsOf(t.id)) {
      await expect(resolveAlertById(a.id, 'trying', 'test')).rejects.toThrow(/closes only when its condition clears/);
    }
    expect((await allAlertsOf(t.id)).every((a) => a.resolvedAt === null)).toBe(true);
  });

  it('audit-note appends a founder note (RESTORE.md in-place record) and changes no lifecycle state', async () => {
    const t = await makeTenant();
    const before = await getTenantRow(t.id);
    await expect(recordFounderNote(t.id, '   ', 'test')).rejects.toThrow(/requires --note/);
    await recordFounderNote(t.id, 'In-place restore to 2026-10-20T14:00Z; erased 3 entries; consent ref CS-12', 'test');
    const notes = (await auditOf(t.id)).filter((e) => e.kind === 'founder-note');
    expect(notes.map((e) => e.detail)).toEqual(['In-place restore to 2026-10-20T14:00Z; erased 3 entries; consent ref CS-12']);
    expect((await getTenantRow(t.id)).lifecycleVersion).toBe(before.lifecycleVersion);
  });

  it('provision:tenant audits the Terms record — or that there was none (audit §5)', async () => {
    const withTerms = await makeTenant();
    await recordProvisionTerms(withTerms.id, { version: '2026-10-21-draft-1', acceptedAt: new Date('2026-10-20T15:30:00Z') }, 'test');
    expect((await auditOf(withTerms.id)).filter((e) => e.kind === 'terms-recorded').map((e) => e.detail)).toEqual([
      "Terms 2026-10-21-draft-1 accepted 2026-10-20T15:30:00.000Z (from the customer's signed agreement; provision:tenant)",
    ]);
    const without = await makeTenant();
    await recordProvisionTerms(without.id, 'none', 'test');
    expect((await auditOf(without.id)).filter((e) => e.kind === 'founder-note').map((e) => e.detail)).toEqual(['provisioned without a Terms record']);
  });

  it('the same alert raised twice upserts one row (empty dedup key included)', async () => {
    const t = await makeTenant();
    await raiseAlert(controlDb, { tenantId: t.id, kind: 'missing-trial-date' }, NOW);
    await raiseAlert(controlDb, { tenantId: t.id, kind: 'missing-trial-date' }, NOW);
    const rows = await allAlertsOf(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// feature-plan-per-user-billing.md §6.2 — S12 (set-plan / Enterprise), S24 (ensure-customer, the Stripe-mode guard)
// ---------------------------------------------------------------------------

describe.skipIf(!cpReady)('tenant:admin per-user billing commands (§6.2)', () => {
  beforeEach(async () => {
    stripeState.reset();
    process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_month';
    process.env.STRIPE_PRICE_STANDARD_ANNUAL = 'price_std_year';
    await cleanupLifecycleTenants();
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
    await cleanupTestData();
  });

  it('S12: a custom-price subscription is never updated (not-standard, unmanaged-price alert); set-plan enterprise → no cap, the alert resolves, a GOOD reconcile keeps enterprise; set-plan standard refused unless enterprise; audited', async () => {
    const { setPlanPlanner, applyAdminPlan, AdminCommandError } = await import('@/lib/tenant/admin-commands');
    const { syncSeatQuantity } = await import('@/lib/billing/seat-sync');
    const { assertSeatsAvailable } = await import('@/server/internal/seats');
    const at101 = { select: () => ({ from: () => ({ where: async () => [{ value: 100 }] }) }) };
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'active', { priceId: 'price_custom_enterprise', quantity: 150 });
    const t = await makeTenant({ plan: 'standard', stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'active', firstGoodAt: daysFrom(new Date(), -30) });
    await createTestUser({ isActive: true });

    expect((await syncSeatQuantity(t.id, { runId: 'r1', reason: 'daily' })).outcome).toBe('not-standard');
    expect(stripeState.updates).toEqual([]);
    expect((await openAlertsOf(t.id)).map((a) => a.kind)).toContain('seat-sync-unmanaged-price');

    expect(() => setPlanPlanner('standard')({ ...t } as never, {} as never, new Date())).toThrow(AdminCommandError);
    await applyAdminPlan(t.id, setPlanPlanner('enterprise'), 'founder:test');
    let row = await getTenantRow(t.id);
    expect(row.plan).toBe('enterprise');
    expect(row.planInterval).toBeNull();
    expect((await openAlertsOf(t.id)).map((a) => a.kind)).not.toContain('seat-sync-unmanaged-price');
    expect((await auditOf(t.id)).find((e) => e.kind === 'plan-set')!.detail).toBe('standard→enterprise');
    await expect(assertSeatsAvailable(1, at101 as never, row.plan)).resolves.toBeUndefined(); // no cap at 101
    await expect(assertSeatsAvailable(1, at101 as never, 'standard')).rejects.toThrow(/covers up to 100 users/);

    expect((await syncSeatQuantity(t.id, { runId: 'r2', reason: 'daily' })).outcome).toBe('not-standard');
    expect((await openAlertsOf(t.id)).map((a) => a.kind)).not.toContain('seat-sync-unmanaged-price'); // enterprise: no alert

    // A GOOD reconcile (the webhook's path) on a Standard price keeps enterprise.
    stripeState.setSub(sub, { priceId: 'price_std_year', interval: 'year' });
    const { withTenantLock } = await import('@/db/control-plane/locked');
    const { reconcileInLock } = await import('@/lib/billing/reconcile');
    const { readTenant } = await import('@/lib/tenant/lifecycle-store');
    const r = await withTenantLock(t.id, async (tx) => reconcileInLock(tx, (await readTenant(tx, t.id))!, new Date()));
    expect(r.tracked?.plan).toBe('standard'); // Stripe says Standard…
    row = await getTenantRow(t.id);
    expect(row.plan).toBe('enterprise');
    expect(row.planInterval).toBeNull();

    await applyAdminPlan(t.id, setPlanPlanner('standard'), 'founder:test');
    expect((await getTenantRow(t.id)).plan).toBe('standard');
    expect((await auditOf(t.id)).map((e) => e.detail)).toContain('enterprise→standard');
    expect(() => setPlanPlanner('pro')).toThrow(AdminCommandError);
  });

  it('S24: ensure-customer creates and links once; a second run prints the same id; audited with livemode; a mode mismatch is refused', async () => {
    const { ensureCustomerCommand, checkStripeMode, AdminCommandError } = await import('@/lib/tenant/admin-commands');
    const t = await makeTenant();
    const first = await ensureCustomerCommand(t.id, 'test', 'founder:test');
    expect(first).toMatch(/^cus_/);
    expect((await getTenantRow(t.id)).stripeCustomerId).toBe(first);
    expect(await ensureCustomerCommand(t.id, 'test', 'founder:test')).toBe(first);
    expect(stripeState.createdCustomers).toBe(1);
    const audits = (await auditOf(t.id)).filter((e) => e.kind === 'stripe-customer-ensured');
    expect(audits.map((e) => e.detail)).toEqual([`customer=${first} livemode=false`, `customer=${first} livemode=false`]);

    expect(checkStripeMode('test', 'sk_test_abc')).toBe('test');
    expect(checkStripeMode('live', 'rk_live_abc')).toBe('live');
    expect(() => checkStripeMode('live', 'sk_test_abc')).toThrow(AdminCommandError);
    expect(() => checkStripeMode(undefined, 'sk_test_abc')).toThrow(/--stripe-mode/);
    expect(() => checkStripeMode('test', 'nonsense')).toThrow(AdminCommandError);

    const closed = await makeTenant({ status: 'deleting' });
    await expect(ensureCustomerCommand(closed.id, 'test', 'founder:test')).rejects.toThrow(/closed/);
  });
});
