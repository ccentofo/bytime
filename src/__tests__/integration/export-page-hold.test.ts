import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const h = vi.hoisted(() => ({ presigned: [] as string[], consumed: [] as string[] }));
vi.mock('@/lib/export/download-url', () => ({
  presignDeliveryUrl: async (key: string) => { h.presigned.push(key); return { ok: true, url: `https://s3.example/${key}?X-Amz-Expires=300` }; },
}));
vi.mock('@/lib/rate-limit/store', () => ({
  consume: async (name: string, id: string) => { h.consumed.push(`${name}:${id}`); return { allowed: true, retryAfterMs: 0, source: 'memory', resetAt: 0 }; },
}));
vi.mock('@/lib/tenant/ops-alert-email', () => ({ raiseAlertWithEmail: async () => ({ opened: false, emailed: false }) }));

import { controlDb } from '@/db/control-plane';
import { exportDeliveries, tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { prepareDownload, readDeliveryByToken } from '@/lib/export/delivery-access';
import { applyAdminPlan, plans } from '@/lib/tenant/admin-commands';
import { makeWorld, type World } from './export-harness';

/**
 * feature-plan-cloud-export.md §11 T28 (A1: the page under a later policy hold, with deliveries made THROUGH `deliver`,
 * never seeded) and T9 (the POST counts the download), against the app's control plane. The presigner and the rate-limit
 * store are faked (no AWS, no Upstash).
 */

const CP = process.env.CONTROL_PLANE_DATABASE_URL;
const d = CP ? describe : describe.skip;

let worlds: World[] = [];
beforeEach(() => { h.presigned = []; h.consumed = []; });
afterEach(async () => {
  for (const w of worlds) await w.cleanup();
  worlds = [];
});
async function world() {
  const w = await makeWorld({ controlPlaneUrl: CP });
  worlds.push(w);
  return w;
}
async function deliver(w: World, extra?: string) {
  const r = await w.run({ mode: 'deliver', ...(extra ? { extra, reason: 'policy case, verified by phone' } : {}) });
  expect(r.exitCode, w.lines.join('\n')).toBe(0);
  const id = r.line.split(', ')[1].replace('delivery ', '');
  const [row] = await controlDb.select().from(exportDeliveries).where(eq(exportDeliveries.id, id));
  return { id, token: decrypt(row.tokenEncrypted!), extraOnly: row.extraOnly };
}
const state = async (token: string) => (await readDeliveryByToken(token)).state;
const post = (token: string) => prepareDownload(token, '198.51.100.7');

d('T28: the page under a later policy hold (A1)', () => {
  it('admins-only and admins-plus-extra deliveries are unavailable on GET and POST (no presign); an extra-only delivery still works; unsuspend makes them available again', async () => {
    const w = await world();
    const adminsOnly = await deliver(w);
    const withExtra = await deliver(w, 'counsel@law.example');
    expect([adminsOnly.extraOnly, withExtra.extraOnly]).toEqual([false, false]);
    // The breach: the founder suspends the workspace for policy (export not re-enabled).
    await applyAdminPlan(w.tenant.id, plans.suspend('policy breach'), 'test');
    const extraOnly = await deliver(w, 'verified@contact.example');
    expect(extraOnly.extraOnly).toBe(true);
    for (const t of [adminsOnly.token, withExtra.token]) {
      expect(await state(t)).toBe('unavailable');
      expect(await post(t)).toEqual({ status: 'unavailable' });
    }
    expect(h.presigned).toEqual([]);
    expect(await state(extraOnly.token)).toBe('valid');
    expect((await post(extraOnly.token)).status).toBe('ready');
    // Lifting the hold before expiry: the admins' links work again.
    await applyAdminPlan(w.tenant.id, plans.unsuspend(), 'test');
    expect(await state(adminsOnly.token)).toBe('valid');
    expect(await state(withExtra.token)).toBe('valid');
  });

  it('set-policy-export on (before deletion) makes them available again; off makes them unavailable', async () => {
    const w = await world();
    const a = await deliver(w);
    await applyAdminPlan(w.tenant.id, plans.suspend('policy breach'), 'test');
    expect(await state(a.token)).toBe('unavailable');
    await applyAdminPlan(w.tenant.id, plans.setPolicyExport(true, 'honest mistake'), 'test');
    expect(await state(a.token)).toBe('valid');
    await applyAdminPlan(w.tenant.id, plans.setPolicyExport(false, 'changed my mind'), 'test');
    expect(await state(a.token)).toBe('unavailable');
  });

  it('still unavailable after the workspace is deleted (the tombstone keeps the reason); an extra-only delivery still works', async () => {
    const w = await world();
    const a = await deliver(w);
    await applyAdminPlan(w.tenant.id, plans.suspend('policy breach'), 'test');
    const x = await deliver(w, 'verified@contact.example');
    // tenant:delete's tombstone (status deleted, the database URL nulled; suspension_reason and policy_export_allowed kept).
    await controlDb.update(tenants).set({ status: 'deleted', dbUrlEncrypted: null, deletedAt: new Date() }).where(eq(tenants.id, w.tenant.id));
    expect(await state(a.token)).toBe('unavailable');
    expect(await state(x.token)).toBe('valid');
  });
});

d('T9: the POST against the real control plane', () => {
  it('counts the download (download_count, last_download_at); the IP limit, then the delivery limit; the presign gets the delivery key', async () => {
    const w = await world();
    const a = await deliver(w);
    expect(await post(a.token)).toMatchObject({ status: 'ready' });
    expect(await post(a.token)).toMatchObject({ status: 'ready' });
    const [row] = await controlDb.select().from(exportDeliveries).where(eq(exportDeliveries.id, a.id));
    expect(row.downloadCount).toBe(2);
    expect(row.lastDownloadAt).toBeInstanceOf(Date);
    expect(h.presigned).toEqual([row.s3Key, row.s3Key]);
    expect(h.consumed.slice(0, 2)).toEqual([expect.stringMatching(/^exportDownloadIp:ip:/), `exportDownload:delivery:${a.id}`]);
  });

  it('a revoked delivery is refused on POST without a presign', async () => {
    const w = await world();
    const a = await deliver(w);
    await controlDb.update(exportDeliveries).set({ revokedAt: new Date() }).where(eq(exportDeliveries.id, a.id));
    expect(await post(a.token)).toEqual({ status: 'unavailable' });
    expect(h.presigned).toEqual([]);
  });
});
