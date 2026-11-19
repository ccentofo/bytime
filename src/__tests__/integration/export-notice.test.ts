import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';

vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);

import { controlDb } from '@/db/control-plane';
import { exportDeliveries, opsAlerts, tenantAuditEvents, tenantNotices, tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { deliverNotice, LINK_REMOVED, resolveRecipientsAndTimezone, setNoticeTimingForTests } from '@/lib/tenant/notices';
import { applyAdminPlan, exportRevoke, findForceableNotice, forceNoticeSent, planExportRevoke, plans, AdminCommandError } from '@/lib/tenant/admin-commands';
import { resendState } from './fakes/fake-resend';
import { dropScratchDb } from './backup-helpers';
import { makeWorld, type World } from './export-harness';
import { resolveD10 } from '../../../scripts/backup/lib/export-recipients';
import { registerTenant } from '../../../scripts/register-tenant';
import { getTenantRow } from './lifecycle-helpers';

/**
 * feature-plan-cloud-export.md §11 T7 (the export-ready notice through deliverNotice), T27 (the batch outcome rules),
 * T21/T24 (`export-revoke`), T29 (the shared D10 fixture: the task's copy equals notices.ts), and T5's tail (a committed
 * export whose acknowledgement was lost still sends its email). The export task runs against the APP's control plane
 * (CONTROL_PLANE_DATABASE_URL) here, so deliverNotice sees its rows; deliveries are made through `deliver`, never seeded.
 */

const CP = process.env.CONTROL_PLANE_DATABASE_URL;
const d = CP ? describe : describe.skip;
const APEX = 'https://cadenzpoint.example';
const MIN = 60_000;

let worlds: World[] = [];
beforeEach(() => {
  resendState.reset();
  setNoticeTimingForTests({ sendTimeoutMs: 300, backoffBaseMs: 5, throttleMs: 0 });
  process.env.NEXT_PUBLIC_APP_URL = APEX;
});
afterEach(async () => {
  for (const w of worlds) await w.cleanup();
  worlds = [];
});
async function world(o: Parameters<typeof makeWorld>[0] = {}) {
  const w = await makeWorld({ controlPlaneUrl: CP, ...o });
  worlds.push(w);
  return w;
}
/** A delivery made through the export task's `deliver`; returns its row (with the plaintext token) and notice id. */
async function delivered(w: World, args: { extra?: string; reason?: string } = {}) {
  const r = await w.run({ mode: 'deliver', ...args });
  expect(r.exitCode, w.lines.join('\n')).toBe(0);
  const [row] = await controlDb.select().from(exportDeliveries).where(eq(exportDeliveries.tenantId, w.tenant.id));
  return { row, token: decrypt(row.tokenEncrypted!), noticeId: row.noticeId };
}
const notice = async (id: string) => (await controlDb.select().from(tenantNotices).where(eq(tenantNotices.id, id)))[0];
const delivery = async (id: string) => (await controlDb.select().from(exportDeliveries).where(eq(exportDeliveries.id, id)))[0];
type Payload = { to: string[]; subject: string; html: string; stated: Record<string, string>; providerIds?: string[] };

d('T7: the export-ready notice through deliverNotice', () => {
  it('one batch message per stored recipient (no bcc, no support copy); recipients recorded; the link via apexBaseUrl(); the time in the stored zone; on send the token is nulled and redacted in one transaction', async () => {
    const w = await world({ admins: ['first@acme.test', 'second@acme.test'], timezone: 'America/Chicago' });
    const { row, token, noticeId } = await delivered(w);
    expect(await deliverNotice(noticeId)).toBe('sent');
    expect(resendState.batchCalls).toHaveLength(1);
    const call = resendState.batchCalls[0];
    expect(call.batchValidation).toBe('strict');
    expect(call.idempotencyKey).toBe(`${noticeId}:0`);
    expect(call.messages.map((m) => m.to)).toEqual([['first@acme.test'], ['second@acme.test'], ['billing@acme.test']].sort());
    for (const m of call.messages) {
      expect(m.bcc).toBeUndefined();
      expect(m.cc).toBeUndefined();
      expect(m.html).toContain(`${APEX}/export/${token}`);
      expect(m.subject).toBe('Your Acme Export Test workspace export is ready');
    }
    expect(resendState.calls).toEqual([]); // never the single-send (D10) path
    const n = await notice(noticeId);
    expect(n.sentAt).not.toBeNull();
    expect([...n.recipients].sort()).toEqual(['billing@acme.test', 'first@acme.test', 'second@acme.test']);
    const p = n.payload as Payload;
    expect(p.providerIds).toHaveLength(3);
    expect(n.providerMessageId).toBe(p.providerIds![0]);
    expect(p.html).not.toContain(token);
    expect(p.html).toContain(`/export/${LINK_REMOVED}`);
    expect(JSON.stringify(p.stated)).not.toContain('/export/');
    expect(p.stated.worksUntil).toMatch(/C[SD]T$/); // America/Chicago
    expect((await delivery(row.id)).tokenEncrypted).toBeNull();
  });

  it('A1: an extra-only (policy-hold) export reaches the verified address alone; no admin is ever sent it', async () => {
    const w = await world({ tenant: { status: 'suspended', suspensionReason: 'policy', policyExportAllowed: false } });
    const { noticeId } = await delivered(w, { extra: 'verified@contact.example', reason: 'policy case' });
    expect(await deliverNotice(noticeId)).toBe('sent');
    expect(resendState.batchCalls[0].messages.map((m) => m.to)).toEqual([['verified@contact.example']]);
  });

  it('sent for a dropped workspace database and for a tombstoned workspace (the branch never reads the workspace database)', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    await w.ws.sql.end({ timeout: 5 });
    await dropScratchDb(w.ws.name);
    await controlDb.execute(`UPDATE tenants SET status = 'deleted', db_url_encrypted = NULL, deleted_at = now() WHERE id = '${w.tenant.id}'`);
    expect(await deliverNotice(noticeId)).toBe('sent');
    expect(resendState.batchCalls).toHaveLength(1);
  });

  it('not superseded by set-exempt or register-tenant (lifecycle supersedes exclude export-ready)', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    await applyAdminPlan(w.tenant.id, plans.setExempt(true, 'demo'), 'test');
    expect((await notice(noticeId)).supersededAt).toBeNull();
    const t = await getTenantRow(w.tenant.id);
    await controlDb.update(tenants).set({ lifecycleExempt: false }).where(eq(tenants.id, t.id)); // so register-tenant flips it again
    await registerTenant(CP!, { slug: t.slug, name: t.name, dbUrlEncrypted: t.dbUrlEncrypted!, exempt: true, actor: 'test' });
    expect((await notice(noticeId)).supersededAt).toBeNull();
    expect(await deliverNotice(noticeId)).toBe('sent');
  });

  for (const [name, mutate] of [
    ['revoked (directly)', (id: string) => controlDb.update(exportDeliveries).set({ revokedAt: new Date() }).where(eq(exportDeliveries.id, id))],
    ['expired', (id: string) => controlDb.update(exportDeliveries).set({ expiresAt: new Date(Date.now() - MIN) }).where(eq(exportDeliveries.id, id))],
    ['erased', (id: string) => controlDb.update(exportDeliveries).set({ erasedAt: new Date() }).where(eq(exportDeliveries.id, id))],
    ['missing', (id: string) => controlDb.delete(exportDeliveries).where(eq(exportDeliveries.id, id))],
  ] as const) {
    it(`superseded when its delivery is ${name}: never D10, nothing sent; the token nulled and redacted on supersede too`, async () => {
      const w = await world();
      const { row, token, noticeId } = await delivered(w);
      // Freeze a payload first (a failed attempt), so the redaction on supersede has a link to remove.
      resendState.batchScript = [{ error: { name: 'application_error', message: 'down', statusCode: 500 } }];
      expect(await deliverNotice(noticeId)).toBe('failed');
      expect((await notice(noticeId)).payload as Payload).toMatchObject({ html: expect.stringContaining(token) });
      await mutate(row.id);
      expect(await deliverNotice(noticeId, new Date(Date.now() + 11 * MIN))).toBe('superseded');
      const n = await notice(noticeId);
      expect(n.supersededAt).not.toBeNull();
      expect((n.payload as Payload).html).not.toContain(token);
      expect(resendState.batchCalls).toHaveLength(1);
      expect(resendState.calls).toEqual([]);
      if (name !== 'missing') expect((await delivery(row.id)).tokenEncrypted).toBeNull();
    });
  }

  it('force-notice-sent refuses an export-ready notice ("use export-revoke")', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    await expect(findForceableNotice(w.tenant.id, 'export-ready')).rejects.toThrow(/use export-revoke/);
    await expect(forceNoticeSent(w.tenant.id, noticeId, 'x', 'test')).rejects.toThrow(/use export-revoke/);
  });

  it('T5 tail: a committed export whose acknowledgement was lost still gets its email', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver' }, { hooks: { afterCommit: async () => { throw new Error('connection lost'); } } });
    expect(r.line).toMatch(/^export outcome unknown: /);
    const [row] = await controlDb.select().from(exportDeliveries).where(eq(exportDeliveries.tenantId, w.tenant.id));
    expect(await deliverNotice(row.noticeId)).toBe('sent');
  });
});

d('T27: the batch outcome rules', () => {
  it('a short array → failed, retried by the next cron with the same key (Resend returns the stored ids) → sent', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    resendState.batchScript = [{ short: 1 }];
    expect(await deliverNotice(noticeId)).toBe('failed');
    expect((await notice(noticeId)).lastError).toMatch(/expected 2 message ids, got 1/);
    expect(await deliverNotice(noticeId, new Date(Date.now() + 11 * MIN))).toBe('sent');
    expect(resendState.batchCalls.map((c) => c.idempotencyKey)).toEqual([`${noticeId}:0`, `${noticeId}:0`]);
    expect(resendState.batchDelivered).toHaveLength(2); // one message per recipient, accepted once
  });

  it('empty ids (a malformed array) → failed', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    resendState.batchScript = [{ malformed: true }];
    expect(await deliverNotice(noticeId)).toBe('failed');
    expect((await notice(noticeId)).sentAt).toBeNull();
  });

  it('a validation_error (strict: all or nothing) → failed, not retried within the claim', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    resendState.batchScript = [{ error: { name: 'validation_error', message: 'Invalid `to` field.', statusCode: 422 } }];
    expect(await deliverNotice(noticeId)).toBe('failed');
    expect(resendState.batchCalls).toHaveLength(1);
  });

  it('a 429 (rate_limit_exceeded) is retried within the claim with the same key, then sent', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    resendState.batchScript = [{ error: { name: 'rate_limit_exceeded', message: 'slow down', statusCode: 429 } }];
    expect(await deliverNotice(noticeId)).toBe('sent');
    expect(resendState.batchCalls.map((c) => c.idempotencyKey)).toEqual([`${noticeId}:0`, `${noticeId}:0`]);
    expect(resendState.batchCalls.every((c) => c.batchValidation === 'strict')).toBe(true);
  });

  it('a timeout counts as failed and is retried later with the same key', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    resendState.batchScript = ['hang'];
    expect(await deliverNotice(noticeId)).toBe('failed');
    expect((await notice(noticeId)).lastError).toBe('send timed out');
    expect(await deliverNotice(noticeId, new Date(Date.now() + 11 * MIN))).toBe('sent');
  });

  it('invalid_idempotent_request raises its existing alert', async () => {
    const w = await world();
    const { noticeId } = await delivered(w);
    resendState.batchScript = [{ error: { name: 'invalid_idempotent_request', message: 'mismatch', statusCode: 409 } }];
    expect(await deliverNotice(noticeId)).toBe('failed');
    const open = await controlDb.select().from(opsAlerts).where(eq(opsAlerts.dedupKey, noticeId));
    expect(open.map((a) => a.kind)).toContain('notice-idempotency-mismatch');
    await controlDb.delete(opsAlerts).where(eq(opsAlerts.dedupKey, noticeId));
  });

  it('the 23-hour refreeze after a failed batch bumps the generation and key, re-renders from token_encrypted, and keeps the stored recipients (never D10)', async () => {
    const w = await world({ admins: ['first@acme.test'] });
    const { token, noticeId } = await delivered(w);
    const t0 = new Date();
    resendState.batchScript = [{ error: { name: 'application_error', message: 'down', statusCode: 500 } }];
    expect(await deliverNotice(noticeId, t0)).toBe('failed');
    // A new admin appears in the workspace: D10 would add them; the export keeps its stored recipients.
    await w.ws.sql`INSERT INTO users (email, full_name, role) VALUES ('late@acme.test', 'Late', 'admin')`;
    expect(await deliverNotice(noticeId, new Date(t0.getTime() + 24 * 3600_000))).toBe('sent');
    const second = resendState.batchCalls[1];
    expect(second.idempotencyKey).toBe(`${noticeId}:1`);
    expect(second.messages.map((m) => m.to[0]).sort()).toEqual(['billing@acme.test', 'first@acme.test']);
    expect(second.messages[0].html).toContain(`/export/${token}`);
    expect((await notice(noticeId)).idempotencyGeneration).toBe(1);
  });
});

d('T21/T24: export-revoke', () => {
  it('refusals: a non-uuid, an unknown id, an already revoked or erased delivery', async () => {
    await expect(planExportRevoke('acme')).rejects.toThrow(AdminCommandError);
    await expect(planExportRevoke('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/No export delivery/);
    const w = await world();
    const { row } = await delivered(w);
    await controlDb.update(exportDeliveries).set({ erasedAt: new Date() }).where(eq(exportDeliveries.id, row.id));
    await expect(planExportRevoke(row.id)).rejects.toThrow(/already erased/);
    await controlDb.update(exportDeliveries).set({ erasedAt: null, revokedAt: new Date() }).where(eq(exportDeliveries.id, row.id));
    await expect(planExportRevoke(row.id)).rejects.toThrow(/already revoked/);
  });

  it('the dry run changes nothing; --yes sets revoked_at, audits export-revoked and supersedes the pending notice (token nulled, link redacted), under the tenant lock', async () => {
    const w = await world();
    const { row, token, noticeId } = await delivered(w);
    resendState.batchScript = [{ error: { name: 'application_error', message: 'down', statusCode: 500 } }];
    await deliverNotice(noticeId); // freeze a payload holding the link
    const plan = await planExportRevoke(row.id, new Date(Date.now() + 11 * MIN));
    expect(plan).toMatchObject({ deliveryId: row.id, tenantId: w.tenant.id, noticePending: true, sendInFlight: false });
    expect((await delivery(row.id)).revokedAt).toBeNull();
    await exportRevoke(row.id, 'test', new Date(Date.now() + 11 * MIN));
    const dlv = await delivery(row.id);
    expect(dlv.revokedAt).not.toBeNull();
    expect(dlv.tokenEncrypted).toBeNull();
    const n = await notice(noticeId);
    expect(n.supersededAt).not.toBeNull();
    expect((n.payload as Payload).html).not.toContain(token);
    const audits = await controlDb.select().from(tenantAuditEvents).where(eq(tenantAuditEvents.tenantId, w.tenant.id));
    expect(audits.map((a) => a.kind)).toContain('export-revoked');
    expect(await deliverNotice(noticeId)).toBe('skipped'); // a superseded notice is never claimed
  });

  it('T24: a live lease (a send in flight) is reported: "the email may already be going out"', async () => {
    const w = await world();
    const { row, noticeId } = await delivered(w);
    await controlDb.update(tenantNotices).set({ lastAttemptAt: new Date() }).where(eq(tenantNotices.id, noticeId));
    const plan = await exportRevoke(row.id, 'test');
    expect(plan.sendInFlight).toBe(true);
    const [a] = (await controlDb.select().from(tenantAuditEvents).where(eq(tenantAuditEvents.tenantId, w.tenant.id))).filter((x) => x.kind === 'export-revoked');
    expect(JSON.parse(a.detail!)).toMatchObject({ deliveryId: row.id, sendInFlight: true });
  });

  it('a revoke after the email was sent: the link is dead (revoked); nothing to supersede', async () => {
    const w = await world();
    const { row, noticeId } = await delivered(w);
    expect(await deliverNotice(noticeId)).toBe('sent');
    const plan = await exportRevoke(row.id, 'test');
    expect(plan.noticePending).toBe(false);
    expect((await notice(noticeId)).supersededAt).toBeNull();
    expect((await delivery(row.id)).revokedAt).not.toBeNull();
  });
});

d('T29: the shared D10 fixture (the task\'s copy equals notices.ts)', () => {
  const states: Array<[string, Parameters<typeof makeWorld>[0], (w: World) => Promise<void>]> = [
    ['admins + billing (a case-different duplicate)', { admins: ['Admin@Acme.test', 'billing@ACME.test'] }, async () => {}],
    ['no admin → the signup email + billing', { admins: [] }, async () => {}],
    ['inactive admins only', { admins: ['old@acme.test'] }, async (w) => { await w.ws.sql`UPDATE users SET is_active = false WHERE role = 'admin'`; }],
    ['no billing email', { admins: ['a@acme.test'], tenant: { billingEmail: null } }, async () => {}],
    ['no billing, no admin, no signup → none', { admins: [], tenant: { billingEmail: null, signupEmail: null } }, async () => {}],
    ['an unknown time zone → the default', { timezone: 'Mars/Olympus' }, async () => {}],
    ['a lower-case zone → canonical', { timezone: 'europe/london' }, async () => {}],
  ];
  for (const [name, o, prep] of states) {
    it(name, async () => {
      const w = await world(o);
      await prep(w);
      const row = await getTenantRow(w.tenant.id);
      const app = await resolveRecipientsAndTimezone(row);
      const ws = postgres(w.ws.url, { max: 1, onnotice: () => {} });
      try {
        const task = await resolveD10({ billingEmail: row.billingEmail, signupEmail: row.signupEmail }, ws);
        expect({ to: [...task.to].sort(), timeZone: task.timeZone }).toEqual({ to: [...app.to].sort(), timeZone: app.timeZone });
      } finally {
        await ws.end({ timeout: 5 });
      }
    });
  }
});
