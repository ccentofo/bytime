import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';

vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);

import { controlDb } from '@/db/control-plane';
import { opsAlerts, tenantNotices } from '@/db/control-plane/schema';
import { withTenantLock } from '@/db/control-plane/locked';
import { deliverNotice, deliverPendingNotices, enqueueNotice, setNoticeTimingForTests } from '@/lib/tenant/notices';
import { sendOpsDigest } from '@/lib/tenant/ops-digest';
import type { NoticeKind } from '@/lib/tenant/lifecycle';
import { resendState } from './fakes/fake-resend';
import { cleanupTestData, createTestUser } from './helpers';
import {
  cpReady, cleanupLifecycleTenants, daysFrom, getTenantRow, insertNotice, makeTenant, openAlertsOf, setTenant,
  type TenantRow,
} from './lifecycle-helpers';

/**
 * feature-plan-terms-compliance-fixes.md §4.5 / §7 "Outbox": the lifecycle notice outbox. A notice is recorded as
 * sent ONLY with a provider message id; retries resend the identical frozen message under the same idempotency
 * key; superseded notices are never sent; the stated deletion date is never earlier than the real one.
 */

const MIN = 60_000;

async function enqueue(tenantId: string, kind: NoticeKind, anchor: Date): Promise<string> {
  const id = await withTenantLock(tenantId, (tx) => enqueueNotice(tx, tenantId, kind, anchor));
  if (!id) throw new Error('enqueue returned null');
  return id;
}

const noticeRow = async (id: string) => (await controlDb.select().from(tenantNotices).where(eq(tenantNotices.id, id)))[0];

describe.skipIf(!cpReady)('lifecycle notice outbox (§4.5)', () => {
  let tenant: TenantRow;
  const T0 = new Date();

  beforeEach(async () => {
    resendState.reset();
    setNoticeTimingForTests({ sendTimeoutMs: 200, backoffBaseMs: 5, throttleMs: 0 });
    await cleanupTestData();
    await cleanupLifecycleTenants();
    await createTestUser({ role: 'admin', email: `admin-${Date.now()}@test.dev`, isActive: true });
    tenant = await makeTenant({ trialEndsAt: daysFrom(T0, 5), billingEmail: 'billing@test.dev' });
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
    await cleanupTestData();
  });

  it('delivers once with a provider id, freezes the exact message, and records D10 recipients', async () => {
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    expect(await deliverNotice(id, T0)).toBe('sent');
    const row = await noticeRow(id);
    expect(row.sentAt).not.toBeNull();
    expect(row.providerMessageId).toMatch(/^msg_/);
    expect(row.recipients).toContain('billing@test.dev');
    expect(row.recipients.some((r) => r.startsWith('admin-'))).toBe(true);
    expect(row.recipients).not.toContain('signup@test.dev'); // an active admin exists
    const payload = row.payload as { subject: string; html: string; stated: Record<string, string> };
    expect(payload.stated.trialEndsAt).toBeTruthy();
    expect(payload.html).toContain(payload.stated.trialEndsAt); // the email states its date
    expect(resendState.delivered).toHaveLength(1);
  });

  it('D10 fallback: no active admin → the signup email, plus the billing email', async () => {
    await cleanupTestData(); // no admins at all
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    await deliverNotice(id, T0);
    const row = await noticeRow(id);
    expect([...row.recipients].sort()).toEqual(['billing@test.dev', 'signup@test.dev']);
  });

  it.each([
    ['an API error', { error: { name: 'application_error', message: 'boom', statusCode: 500 } }],
    ['a thrown network error', 'throw'],
    ['a response without a message id', { noId: true }],
  ] as const)('%s leaves it pending; the retry sends the identical body under the same key', async (_label, failure) => {
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    resendState.script = [failure as never];
    expect(await deliverNotice(id, T0)).toBe('failed');
    let row = await noticeRow(id);
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toBeTruthy();

    // Within the 10-minute lease nobody else may claim it.
    expect(await deliverNotice(id, new Date(T0.getTime() + 5 * MIN))).toBe('skipped');

    expect(await deliverNotice(id, new Date(T0.getTime() + 11 * MIN))).toBe('sent');
    row = await noticeRow(id);
    expect(row.sentAt).not.toBeNull();
    expect(resendState.calls).toHaveLength(2);
    expect(resendState.calls[1].html).toBe(resendState.calls[0].html);
    expect(resendState.calls[1].idempotencyKey).toBe(resendState.calls[0].idempotencyKey);
    expect(resendState.calls[0].idempotencyKey).toBe(`${id}:0`);
  });

  it.each([
    ['429 rate limit', { error: { name: 'rate_limit_exceeded', message: 'slow down', statusCode: 429 } }],
    ['409 concurrent request', { error: { name: 'concurrent_idempotent_requests', message: 'try later', statusCode: 409 } }],
  ] as const)('%s is retried with backoff inside the same claim', async (_label, failure) => {
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    resendState.script = [failure as never, 'ok'];
    expect(await deliverNotice(id, T0)).toBe('sent');
    expect(resendState.calls).toHaveLength(2);
  });

  it('409 invalid_idempotent_request raises an alert and stays unsent', async () => {
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    resendState.script = [{ error: { name: 'invalid_idempotent_request', message: 'changed', statusCode: 409 } }];
    expect(await deliverNotice(id, T0)).toBe('failed');
    expect((await noticeRow(id)).sentAt).toBeNull();
    expect((await openAlertsOf(tenant.id)).map((a) => a.kind)).toContain('notice-idempotency-mismatch');
  });

  it('a timed-out send is retried later with the same key and is delivered exactly once', async () => {
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    resendState.script = ['hang'];
    expect(await deliverNotice(id, T0)).toBe('failed');
    expect((await noticeRow(id)).lastError).toContain('timed out');
    expect(await deliverNotice(id, new Date(T0.getTime() + 11 * MIN))).toBe('sent');
    expect(resendState.calls.map((c) => c.idempotencyKey)).toEqual([`${id}:0`, `${id}:0`]);
  });

  it('keeps the key within 23 h of the first attempt and starts a new generation after', async () => {
    await setTenant(tenant.id, { trialEndsAt: daysFrom(T0, 40) });
    const T = (await getTenantRow(tenant.id)).trialEndsAt!;
    // A 7-day reminder anchored 40 days out stays valid across the simulated day.
    const id = await enqueue(tenant.id, 'trial-reminder-7d', T);
    resendState.script = ['throw', 'throw'];
    await deliverNotice(id, T0);
    await deliverNotice(id, new Date(T0.getTime() + 22 * 60 * MIN));
    expect(await deliverNotice(id, new Date(T0.getTime() + 24 * 60 * MIN))).toBe('sent');
    const keys = resendState.calls.map((c) => c.idempotencyKey);
    expect(keys).toEqual([`${id}:0`, `${id}:0`, `${id}:1`]);
    expect((await noticeRow(id)).idempotencyGeneration).toBe(1);
  });

  it('concurrent deliveries of one notice send it once', async () => {
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    const outcomes = await Promise.all([deliverNotice(id, T0), deliverNotice(id, T0), deliverNotice(id, T0)]);
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(resendState.calls).toHaveLength(1);
  });

  describe('supersede predicates — never sent once the facts moved on', () => {
    it('trial reminder after the workspace subscribed', async () => {
      const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
      await setTenant(tenant.id, { firstGoodAt: T0, subscriptionStatus: 'active' });
      expect(await deliverNotice(id, T0)).toBe('superseded');
      expect(resendState.calls).toHaveLength(0);
    });
    it('trial reminder after extend-trial moved T', async () => {
      const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
      await setTenant(tenant.id, { trialEndsAt: daysFrom(T0, 30) });
      expect(await deliverNotice(id, T0)).toBe('superseded');
    });
    it('trial-ended for an exempt workspace', async () => {
      const id = await enqueue(tenant.id, 'trial-ended', tenant.trialEndsAt!);
      await setTenant(tenant.id, { lifecycleExempt: true });
      expect(await deliverNotice(id, T0)).toBe('superseded');
    });
    it('payment-failed after the grace clock changed (paid and failed again)', async () => {
      const P = daysFrom(T0, -2);
      await setTenant(tenant.id, { firstGoodAt: daysFrom(T0, -60), subscriptionStatus: 'past_due', pastDueSince: P });
      const id = await enqueue(tenant.id, 'payment-failed', P);
      await setTenant(tenant.id, { pastDueSince: daysFrom(T0, -1) });
      expect(await deliverNotice(id, T0)).toBe('superseded');
    });
    it('suspended notice after suspended_at changed', async () => {
      const Sa = daysFrom(T0, -1);
      await setTenant(tenant.id, { status: 'suspended', suspendedAt: Sa, suspensionReason: 'nonpayment' });
      const id = await enqueue(tenant.id, 'suspended', Sa);
      await setTenant(tenant.id, { suspendedAt: daysFrom(T0, -3) });
      expect(await deliverNotice(id, T0)).toBe('superseded');
    });
    it('deletion notice for an old anchor', async () => {
      const E = daysFrom(T0, -80);
      await setTenant(tenant.id, { firstGoodAt: daysFrom(T0, -200), subscriptionEndedAt: E, deletionScheduledFor: daysFrom(T0, 10) });
      const id = await enqueue(tenant.id, 'deletion-notice', E);
      await setTenant(tenant.id, { subscriptionEndedAt: daysFrom(T0, -79) });
      expect(await deliverNotice(id, T0)).toBe('superseded');
    });
    it('subscription-ended after the end was moved (e.g. the customer re-subscribed)', async () => {
      const E = daysFrom(T0, -1);
      await setTenant(tenant.id, { firstGoodAt: daysFrom(T0, -90), subscriptionEndedAt: E, deletionScheduledFor: daysFrom(T0, 89) });
      const id = await enqueue(tenant.id, 'subscription-ended', E);
      await setTenant(tenant.id, { subscriptionEndedAt: null, deletionScheduledFor: null, subscriptionStatus: 'active' });
      expect(await deliverNotice(id, T0)).toBe('superseded');
    });
    it('anything for a workspace being deleted', async () => {
      const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
      await setTenant(tenant.id, { status: 'deleting' });
      expect(await deliverNotice(id, T0)).toBe('superseded');
    });
  });

  it('a superseded, never-sent row is revived with a fresh payload, key and attempt counters', async () => {
    const id = await enqueue(tenant.id, 'trial-ended', tenant.trialEndsAt!);
    await controlDb.update(tenantNotices).set({
      supersededAt: T0, attempts: 4, lastError: 'old', payload: { to: [], subject: 'x', html: 'x', stated: {} },
      payloadFrozenAt: T0, firstAttemptAt: T0, forcedAt: T0, forcedReason: 'old override',
    }).where(eq(tenantNotices.id, id));
    const again = await enqueue(tenant.id, 'trial-ended', tenant.trialEndsAt!);
    expect(again).toBe(id);
    const row = await noticeRow(id);
    expect(row.supersededAt).toBeNull();
    expect(row.payload).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.firstAttemptAt).toBeNull();
    expect(row.forcedAt).toBeNull(); // revival clears a founder override from the old cycle
    expect(row.forcedReason).toBeNull();
    expect(row.idempotencyGeneration).toBe(1);
  });

  it('a sent row is never revived or touched by a re-enqueue', async () => {
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    await deliverNotice(id, T0);
    const before = await noticeRow(id);
    const again = await withTenantLock(tenant.id, (tx) => enqueueNotice(tx, tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!));
    expect(again).toBeNull();
    expect((await noticeRow(id)).idempotencyGeneration).toBe(before.idempotencyGeneration);
  });

  it('a forced notice is never claimed or sent', async () => {
    const id = await enqueue(tenant.id, 'trial-ended', tenant.trialEndsAt!);
    await controlDb.update(tenantNotices).set({ forcedAt: T0, forcedReason: 'test' }).where(eq(tenantNotices.id, id));
    expect(await deliverNotice(id, T0)).toBe('skipped');
    expect(resendState.calls).toHaveLength(0);
  });

  it('deletion notice: D is pushed to at least now + 14 d before rendering, and the email states the real D', async () => {
    const E = daysFrom(T0, -86);
    await setTenant(tenant.id, { firstGoodAt: daysFrom(T0, -200), subscriptionEndedAt: E, subscriptionStatus: 'canceled', deletionScheduledFor: daysFrom(T0, 3) });
    const id = await enqueue(tenant.id, 'deletion-notice', E);
    expect(await deliverNotice(id, T0)).toBe('sent');
    const t = await getTenantRow(tenant.id);
    const row = await noticeRow(id);
    expect(t.deletionScheduledFor!.getTime()).toBeGreaterThanOrEqual(daysFrom(row.payloadFrozenAt!, 14).getTime());
    expect(t.deletionScheduledFor!.getTime()).toBeGreaterThanOrEqual(daysFrom(row.sentAt!, 14).getTime());
    const stated = (row.payload as { stated: Record<string, string> }).stated.deletionDate;
    expect((row.payload as { html: string }).html).toContain(stated);
  });

  it('email disabled → pending with last_error, never recorded as sent', async () => {
    resendState.enabled = false;
    const id = await enqueue(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    expect(await deliverNotice(id, T0)).toBe('failed');
    const row = await noticeRow(id);
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toBe('email disabled');
  });

  it('deliverPendingNotices retries every pending row outside its lease', async () => {
    const a = await insertNotice(tenant.id, 'trial-reminder-7d', tenant.trialEndsAt!);
    const b = await insertNotice(tenant.id, 'trial-ended', tenant.trialEndsAt!, { lastAttemptAt: new Date() }); // leased
    const counts = await deliverPendingNotices(10_000, new Date(), [tenant.id]); // never touch other tenants' notices
    expect(counts.sent).toBeGreaterThanOrEqual(1);
    expect((await noticeRow(a.id)).sentAt).not.toBeNull();
    expect((await noticeRow(b.id)).sentAt).toBeNull();
  });

  it('digest send failure raises an alert; the next success resolves it', async () => {
    const prev = process.env.OPS_ALERT_EMAIL;
    process.env.OPS_ALERT_EMAIL = 'ops@test.dev';
    try {
      // Something to report: an unresolved alert on the test tenant.
      await insertNotice(tenant.id, 'trial-ended', tenant.trialEndsAt!, { createdAt: daysFrom(T0, -2) });
      resendState.script = [{ error: { name: 'application_error', message: 'down', statusCode: 500 } }];
      expect(await sendOpsDigest([], T0, false)).toBe('failed');
      const open = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.kind, 'digest-send-failed'), isNull(opsAlerts.resolvedAt)));
      expect(open.length).toBe(1);
      expect(await sendOpsDigest([], T0, false)).toBe('sent');
      const after = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.kind, 'digest-send-failed'), isNull(opsAlerts.resolvedAt)));
      expect(after.length).toBe(0);
    } finally {
      process.env.OPS_ALERT_EMAIL = prev;
    }
  });
});
