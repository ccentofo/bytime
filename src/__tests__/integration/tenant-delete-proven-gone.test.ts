import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);
// Step 5 against a proven-gone project: Neon answers 404, i.e. `alreadyDeleted` (neon.ts:200-211). The real call would
// reach console.neon.tech, so it is replaced; everything else in neon.ts is real.
const neonDeletes: string[] = [];
vi.mock('@/lib/tenant/neon', async (orig) => ({
  ...(await orig<typeof import('@/lib/tenant/neon')>()),
  deleteNeonProjectVerified: async (i: { projectId: string }) => { neonDeletes.push(i.projectId); return { alreadyDeleted: true }; },
  neonProjectExists: async () => false,
}));

import { encrypt } from '@/lib/encryption';
import { deleteTenant, type DeleteTenantOptions } from '@/lib/tenant/delete-tenant';
import type { NeonFetch } from '@/lib/tenant/disaster-status';
import type { Connector } from '../../../scripts/backup/lib/classify-endpoint';
import { stripeState } from './fakes/fake-stripe';
import { startFakeNeon, fakeHost, poolerOf, type FakeNeon } from '../helpers/fake-neon';
import { auditOf, cleanupLifecycleTenants, cpReady, daysFrom, getTenantRow, insertNotice, makeTenant, type TenantRow } from './lifecycle-helpers';

/**
 * feature-plan-control-plane-disaster.md §11 T23 (§6.6, §7.4): `tenant:delete --project-proven-gone`. Each check of §7.4
 * refuses alone; all passing runs the normal flow (Stripe, the tombstone, the receipt line). The fake Neon API stands in
 * for the app's Organization key (the seam adds the org the real key would imply); the connection probe is a seam. Only
 * the local control plane's throwaway `test-lc-*` rows are touched; no workspace database exists or is dropped.
 */

const CP_URL = process.env.CONTROL_PLANE_DATABASE_URL ?? '';
const isLocal = cpReady && ['localhost', '127.0.0.1'].includes(new URL(CP_URL || 'postgresql://x@remote/x').hostname);

describe.skipIf(!isLocal)('tenant:delete --project-proven-gone (T23)', () => {
  const NOW = new Date();
  let neon: FakeNeon;
  let cpProjectId: string;
  let auth: Connector;
  let fetchNeon: NeonFetch;

  beforeAll(async () => {
    neon = await startFakeNeon();
    // The control plane's own project lists an endpoint on CONTROL_PLANE_DATABASE_URL's host (localhost here).
    cpProjectId = neon.addProject({ name: 'cadenzpoint-control-prod', host: new URL(CP_URL).hostname }).id;
    fetchNeon = async (path) => {
      const u = new URL(`http://x${path}`);
      if (u.pathname === '/projects') u.searchParams.set('org_id', neon.orgId); // an Organization key implies its org
      const res = await fetch(`${neon.url}${u.pathname}${u.search}`, { headers: { Authorization: `Bearer ${neon.apiKey}` } });
      let json: Record<string, unknown> | null = null;
      try { json = (await res.json()) as Record<string, unknown>; } catch { json = null; }
      return { status: res.status, json };
    };
  });
  afterAll(async () => { await neon?.close(); });
  beforeEach(async () => {
    stripeState.reset();
    neonDeletes.length = 0;
    auth = async () => ({ cls: 'auth', code: '28P01' });
    vi.stubEnv('CONTROL_PLANE_PROJECT_ID', cpProjectId);
    await cleanupLifecycleTenants();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupLifecycleTenants();
  });

  /** An eligible workspace (date passed, notice given) whose own Neon project is gone: its host is Neon-shaped. */
  async function goneTenant(o: { state?: 'gone' | 'recoverable' | 'live'; due?: boolean } = {}): Promise<TenantRow & { host: string }> {
    const host = fakeHost();
    const p = neon.addProject({ name: 'placeholder', host });
    const t = await makeTenant({
      trialEndsAt: daysFrom(NOW, -120), deletionScheduledFor: o.due === false ? daysFrom(NOW, 10) : daysFrom(NOW, -1),
      dbUrlEncrypted: encrypt(`postgres://u:p@${poolerOf(host)}/tenant_x`), neonProjectId: p.id,
    });
    neon.projects.get(p.id)!.name = `cadenzpoint-${t.slug}`;
    if ((o.state ?? 'gone') === 'gone') neon.purge(p.id);
    if (o.state === 'recoverable') neon.markDeleted(p.id);
    const row = await getTenantRow(t.id);
    await insertNotice(t.id, 'deletion-notice', row.trialEndsAt!, { sentAt: daysFrom(row.deletionScheduledFor!, -20), providerMessageId: 'msg_dn' });
    return { ...row, host };
  }
  const run = (slug: string, o: Partial<DeleteTenantOptions> = {}) => deleteTenant({
    slug, apply: true, actor: 'test', log: () => {}, projectProvenGone: true, provenGoneSeams: { neon: fetchNeon, connect: auth }, ...o,
  });
  const refusedWith = (r: Awaited<ReturnType<typeof run>>, check: string) => {
    expect(r.outcome).toBe('refused');
    expect((r as { reason: string }).reason).toContain(`--project-proven-gone refused (${check})`);
  };
  const unchanged = async (t: TenantRow) => {
    const after = await getTenantRow(t.id);
    expect(after.status).toBe(t.status);
    expect(after.lifecycleVersion).toBe(t.lifecycleVersion);
    expect(stripeState.calls).toEqual([]);
    expect(neonDeletes).toEqual([]);
  };

  it('all checks pass → the normal flow: Stripe steps, step 5 (alreadyDeleted), the tombstone, the audit marker and the receipt line', async () => {
    const t = await goneTenant();
    stripeState.customers.set('cus_pg', { deleted: false });
    const { controlDb } = await import('@/db/control-plane');
    const { tenants } = await import('@/db/control-plane/schema');
    const { eq } = await import('drizzle-orm');
    await controlDb.update(tenants).set({ stripeCustomerId: 'cus_pg' }).where(eq(tenants.id, t.id));
    const lines: string[] = [];
    const r = await run(t.slug, { log: (l) => lines.push(l) });
    expect(r.outcome).toBe('deleted');
    expect(stripeState.calls).toContain('subscriptions.list'); // the Stripe safeguards ran
    expect(neonDeletes).toEqual([t.neonProjectId]);
    expect((await getTenantRow(t.id)).status).toBe('deleted');
    const started = (await auditOf(t.id)).find((a) => a.kind === 'deletion-started')!;
    expect(started.detail).toMatch(/\(project-proven-gone, proven at \d{4}-\d{2}-\d{2}T/);
    const receipt = (r as { receipt: { database: string } }).receipt;
    expect(receipt.database).toMatch(new RegExp(`^Neon project ${t.neonProjectId} \\(already gone; proven at \\d{4}-`));
    expect(lines.some((l) => l.startsWith(`Project ${t.neonProjectId} is proven gone`))).toBe(true);
    // A later run prints the same receipt line (read from the audit).
    const again = await run(t.slug);
    expect(again.outcome).toBe('already-deleted');
    expect((again as { receipt: { database: string } }).receipt.database).toBe(receipt.database);
  });

  it('the dry run runs the proof too (read-only)', async () => {
    const t = await goneTenant({ state: 'live' });
    const r = await run(t.slug, { apply: false });
    refusedWith(r, 'project-404');
    const ok = await goneTenant();
    expect((await run(ok.slug, { apply: false })).outcome).toBe('dry-run');
    await unchanged(t);
  });

  describe('each check of §7.4 refuses alone, and nothing changes', () => {
    it('CONTROL_PLANE_PROJECT_ID missing', async () => {
      const t = await goneTenant();
      vi.stubEnv('CONTROL_PLANE_PROJECT_ID', '');
      refusedWith(await run(t.slug), 'control-plane-project-id');
      await unchanged(t);
    });
    it('the positive control: the id is not in the org list; the list is incomplete; the control plane\'s endpoint host differs', async () => {
      const t = await goneTenant();
      vi.stubEnv('CONTROL_PLANE_PROJECT_ID', 'prj-elsewhere');
      refusedWith(await run(t.slug), 'positive-control');
      vi.stubEnv('CONTROL_PLANE_PROJECT_ID', cpProjectId);
      neon.unavailable = { ids: ['prj-x'], calls: 1 };
      refusedWith(await run(t.slug), 'positive-control');
      neon.unavailable = { ids: [], calls: 0 };
      vi.stubEnv('CONTROL_PLANE_DATABASE_URL', CP_URL.replace(/@(localhost|127\.0\.0\.1)/, '@ep-stale-1.us-east-1.aws.neon.tech'));
      const r = await run(t.slug);
      vi.stubEnv('CONTROL_PLANE_DATABASE_URL', CP_URL);
      refusedWith(r, 'positive-control');
      expect((r as { reason: string }).reason).toContain("doesn't serve CONTROL_PLANE_DATABASE_URL's host");
      await unchanged(t);
    });
    it('GET is not 404 (the project still exists; or the lookup fails)', async () => {
      const t = await goneTenant({ state: 'live' });
      refusedWith(await run(t.slug), 'project-404');
      const u = await goneTenant();
      neon.script('GET /projects/:id', [503], u.neonProjectId!);
      refusedWith(await run(u.slug), 'project-404');
      await unchanged(t);
    });
    it('the URL result is not `auth`: a timeout, a socket error, a proxy error, 3D000, a post-auth answer, a login', async () => {
      const t = await goneTenant();
      for (const c of [{ cls: 'socket', code: 'CONNECT_TIMEOUT' }, { cls: 'socket', code: 'ECONNREFUSED' }, { cls: 'proxy', code: 'XX000' }, { cls: 'database-missing', code: '3D000' }, { cls: 'post-auth', code: '53300' }, { cls: 'ok', code: null }] as const) {
        auth = async () => c;
        const r = await run(t.slug);
        refusedWith(r, 'url-auth');
        expect((r as { reason: string }).reason).toContain("couldn't prove the database is gone");
      }
      await unchanged(t);
    });
    it('a live org project serves the tenant\'s host (a stale password); an endpoints call failing', async () => {
      const t = await goneTenant();
      const live = neon.addProject({ name: `cadenzpoint-${t.slug}`, host: t.host });
      refusedWith(await run(t.slug), 'not-served');
      neon.script('GET /projects/:id/endpoints', [503], live.id);
      refusedWith(await run(t.slug), 'not-served');
      neon.purge(live.id);
      await unchanged(t);
    });
    it('not a dedicated Neon project (a local database)', async () => {
      const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -120), deletionScheduledFor: daysFrom(NOW, -1), dbUrlEncrypted: encrypt(CP_URL.replace(/\/[^/]*$/, '/cadenzpoint_pg_none')) });
      const r = await run(t.slug);
      expect(r.outcome).toBe('refused');
      expect((r as { reason: string }).reason).toContain('only for a workspace with its own Neon project');
    });
  });

  it('a recoverable project: the notice is printed and the deletion goes on', async () => {
    const t = await goneTenant({ state: 'recoverable' });
    const lines: string[] = [];
    expect((await run(t.slug, { log: (l) => lines.push(l) })).outcome).toBe('deleted');
    expect(lines.some((l) => l.startsWith('Neon can still recover this project until'))).toBe(true);
  });

  it('preconditions still apply without --force-with-reason (date not passed → not eligible); with it, the forced flow runs', async () => {
    const t = await goneTenant({ due: false });
    const r = await run(t.slug);
    expect(r.outcome).toBe('refused');
    expect((r as { reason: string }).reason).toMatch(/Not eligible: .*has not passed/);
    expect((await run(t.slug, { forceWithReason: 'deleted in the lost window; receipt R-1' })).outcome).toBe('deleted');
  });

  it('without the flag the "not found" refusal is unchanged; on a resumed `deleting` run the flag is a no-op', async () => {
    const t = await goneTenant();
    const r = await deleteTenant({ slug: t.slug, apply: true, actor: 'test', log: () => {} });
    expect(r.outcome).toBe('refused');
    expect((r as { reason: string }).reason).toContain('The tenant database was not found');
    const { controlDb } = await import('@/db/control-plane');
    const { tenants } = await import('@/db/control-plane/schema');
    const { eq } = await import('drizzle-orm');
    await controlDb.update(tenants).set({ status: 'deleting' }).where(eq(tenants.id, t.id));
    let probed = 0;
    auth = async () => { probed++; return { cls: 'auth', code: '28P01' }; };
    expect((await run(t.slug)).outcome).toBe('deleted');
    expect(probed).toBe(0); // the proof never ran
  });
});
