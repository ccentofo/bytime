import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';

/**
 * feature-plan-disaster-restore.md §11 R8 (second half): a disaster switch committed between `tenant:delete`'s steps 2
 * and 3 → refused inside step 3's lock (the URL and project id no longer equal step 1's), so the old original is never
 * deleted and the rebuilt project never orphaned. The switch is simulated by updating the row right before step 3's
 * locked read (the real switch takes the same tenant lock, so it can only land before it). Throwaway local databases.
 */

/** Runs `fn` right before the `onCall`-th readTenant (1 = step 3's reconcile section, 2 = its set-deleting section). */
const hook: { beforeRead: null | (() => Promise<void>); onCall: number; calls: number } = { beforeRead: null, onCall: 1, calls: 0 };
vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);
const reconcileCalls = { n: 0 };
vi.mock('@/lib/billing/reconcile', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/billing/reconcile')>();
  return { ...orig, reconcileInLock: async (...a: Parameters<typeof orig.reconcileInLock>) => { reconcileCalls.n++; return orig.reconcileInLock(...a); } };
});
vi.mock('@/lib/tenant/lifecycle-store', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/tenant/lifecycle-store')>();
  return {
    ...orig,
    readTenant: async (...a: Parameters<typeof orig.readTenant>) => {
      hook.calls++;
      const h = hook.beforeRead;
      if (h && hook.calls === hook.onCall) { hook.beforeRead = null; await h(); }
      return orig.readTenant(...a);
    },
  };
});

import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { eq } from 'drizzle-orm';
import { encrypt } from '@/lib/encryption';
import { deleteTenant } from '@/lib/tenant/delete-tenant';
import { stripeState } from './fakes/fake-stripe';
import { cpReady, cleanupLifecycleTenants, daysFrom, getTenantRow, insertNotice, makeTenant } from './lifecycle-helpers';

const CP_URL = process.env.CONTROL_PLANE_DATABASE_URL ?? '';
const loopback = (u: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u || 'postgresql://x@remote/x').hostname);
const created: string[] = [];
const admin = async <T,>(fn: (sql: postgres.Sql) => Promise<T>) => { const s = postgres(CP_URL, { max: 1 }); try { return await fn(s); } finally { await s.end(); } };

describe.skipIf(!(cpReady && loopback(CP_URL)))('R8: a disaster switch between tenant:delete\'s steps 2 and 3', () => {
  beforeEach(async () => { stripeState.reset(); await cleanupLifecycleTenants(); });
  afterEach(async () => { hook.beforeRead = null; hook.onCall = 1; hook.calls = 0; await cleanupLifecycleTenants(); });
  afterAll(async () => { for (const n of created) await admin((s) => s.unsafe(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`)); });

  it('is refused inside step 3\'s lock: nothing deleted, the workspace still active', async () => {
    const name = `cadenzpoint_deltest_${Date.now().toString(36)}_dr`;
    await admin((s) => s.unsafe(`CREATE DATABASE ${name}`));
    created.push(name);
    const u = new URL(CP_URL);
    u.pathname = `/${name}`;
    const NOW = new Date();
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -120), deletionScheduledFor: daysFrom(NOW, -1), dbUrlEncrypted: encrypt(u.toString()) });
    const row = await getTenantRow(t.id);
    await insertNotice(t.id, 'deletion-notice', row.trialEndsAt!, { sentAt: daysFrom(row.deletionScheduledFor!, -20), providerMessageId: 'msg_dn' });
    hook.beforeRead = async () => {
      // The "switch": a rebuilt project's URL and id, committed before step 3's lock.
      await controlDb.update(tenants).set({ dbUrlEncrypted: encrypt(`${u.toString()}?rebuilt=1`), neonProjectId: 'prj-rebuilt' }).where(eq(tenants.id, t.id));
    };
    const r = await deleteTenant({ slug: t.slug, apply: true, actor: 'test', log: () => {} });
    expect(r.outcome).toBe('refused');
    if (r.outcome === 'refused') expect(r.reason).toContain("database changed since this run started");
    expect(await admin(async (s) => (await s`SELECT 1 FROM pg_database WHERE datname = ${name}`).length)).toBe(1);
    expect((await getTenantRow(t.id)).status).toBe('active');
  });

  // Fix round 1, FR4 (M53, M54, M65): each locked section's guard alone, and a URL-only or a project-id-only change.
  async function eligible() {
    const name = `cadenzpoint_deltest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin((s2) => s2.unsafe(`CREATE DATABASE ${name}`));
    created.push(name);
    const u = new URL(CP_URL);
    u.pathname = `/${name}`;
    const NOW = new Date();
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -120), deletionScheduledFor: daysFrom(NOW, -1), dbUrlEncrypted: encrypt(u.toString()), neonProjectId: null });
    const row = await getTenantRow(t.id);
    await insertNotice(t.id, 'deletion-notice', row.trialEndsAt!, { sentAt: daysFrom(row.deletionScheduledFor!, -20), providerMessageId: 'msg_dn' });
    return { t, url: u.toString(), name };
  }
  for (const section of [1, 2]) {
    for (const change of ['url', 'project'] as const) {
      it(`section ${section} alone refuses a ${change === 'url' ? 'URL-only' : 'project-id-only'} change`, async () => {
        const { t, url, name } = await eligible();
        hook.onCall = section;
        hook.beforeRead = async () => {
          await controlDb.update(tenants).set(change === 'url' ? { dbUrlEncrypted: encrypt(`${url}?rebuilt=1`) } : { neonProjectId: 'prj-rebuilt' }).where(eq(tenants.id, t.id));
        };
        reconcileCalls.n = 0;
        const r = await deleteTenant({ slug: t.slug, apply: true, actor: 'test', log: () => {} });
        expect(r.outcome).toBe('refused');
        if (r.outcome === 'refused') expect(r.reason).toContain('database changed since this run started');
        expect(await admin(async (s2) => (await s2`SELECT 1 FROM pg_database WHERE datname = ${name}`).length)).toBe(1);
        // Section 1 refuses before the reconcile runs; section 2 only after it.
        expect(reconcileCalls.n).toBe(section === 1 ? 0 : 1);
      });
    }
  }
});
