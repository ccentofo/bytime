import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);

import { controlDb } from '@/db/control-plane';
import {
  AdminCommandError, applyAdminPlan, findForceableNotice, forceNoticeSent, plans, recordFounderExportDisposal,
  recordFounderNote, recordProvisionTerms, resolveAlertById,
} from '@/lib/tenant/admin-commands';
import { runTenantLifecycle } from '@/lib/tenant/lifecycle-runner';
import { raiseAlert, recordAudit } from '@/lib/tenant/lifecycle-store';
import { deliverPendingNotices, setNoticeTimingForTests } from '@/lib/tenant/notices';
import { canExport, getTenantAccess } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { stripeState } from './fakes/fake-stripe';
import { resendState } from './fakes/fake-resend';
import { cleanupTestData, createTestUser } from './helpers';
import {
  cpReady, allAlertsOf, auditOf, cleanupLifecycleTenants, daysFrom, getTenantRow, insertNotice, makeTenant, noticesOf,
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

  it('resolve-alert resolves once (bookkeeping only); export-destroyed requires a recorded export', async () => {
    const t = await makeTenant();
    await raiseAlert(controlDb, { tenantId: t.id, kind: 'paused-subscription', dedupKey: 'sub_1' }, NOW);
    const [alert] = await allAlertsOf(t.id);
    await resolveAlertById(alert.id, 'handled in Stripe', 'test');
    await expect(resolveAlertById(alert.id, 'again', 'test')).rejects.toThrow(/Already resolved/);

    await expect(recordFounderExportDisposal(t.id, undefined, 'test')).rejects.toThrow(/No founder export/);
    await recordAudit(controlDb, { tenantId: t.id, kind: 'founder-export-taken', actor: 'test', detail: '{}' });
    await recordFounderExportDisposal(t.id, undefined, 'test');
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('founder-export-destroyed');
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
