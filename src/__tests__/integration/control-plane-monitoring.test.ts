import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));

import { and, eq, gte, inArray, isNull, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { controlDb } from '@/db/control-plane';
import { disasterRuns, opsAlerts, tenants } from '@/db/control-plane/schema';
import { disasterDigestLines, syncDisasterAlerts, syncWindowProjects, type NeonFetch } from '@/lib/tenant/disaster-status';
import { checkSlugAvailableInternal } from '@/server/internal/signup';
import { ProvisionConflictError, provisionTenant } from '@/lib/tenant/provision';
import { invalidateTenant } from '@/lib/tenant/registry';
import { cleanupLifecycleTenants, cpReady, makeTenant } from './lifecycle-helpers';

/**
 * feature-plan-control-plane-disaster.md §11 T25 (window addresses at signup and provisioning), T26 (the window-project
 * daily check; the control-plane watch wording), T12 (the daily checks raise nothing about a rebuilt control plane), T20's
 * digest close, and D10's digest line. Against the local control plane, with this file's own keys (`test-cpm-`), and a
 * stubbed Neon API. Never a workspace database.
 */

const H = 3600_000;
const PREFIX = 'test-cpm-';
const CP_ID = 'prj-test-cpm-newcp';
const ENV = { BACKUPS_EXPECTED: '1', CONTROL_PLANE_PROJECT_ID: CP_ID };

describe.skipIf(!cpReady)('3c-2: window addresses and monitoring', () => {
  const keys: string[] = [];
  const live = new Set<string>([CP_ID]);
  let neonFails = false;
  const neon: NeonFetch = async (path) => {
    if (neonFails) throw new Error('neon down');
    if (path.startsWith('/projects?')) return { status: 200, json: { projects: path.includes('cursor=') || path.includes('recoverable=true') ? [] : [...live].map((id) => ({ id, name: id })), pagination: { cursor: 'c' } } };
    const id = decodeURIComponent(path.split('/')[2].split('?')[0]);
    return { status: live.has(id) ? 200 : 404, json: {} };
  };
  const key = (k: string) => { const v = `${PREFIX}${k}-${randomUUID().slice(0, 6)}`; keys.push(v); return v; };
  const windowAlert = async (projectId: string, slug: string | null) => {
    await controlDb.insert(opsAlerts).values({ scope: 'global', tenantId: null, kind: 'window-project', dedupKey: projectId, detail: { projectId, name: `cadenzpoint-${slug}`, createdAt: new Date().toISOString(), slug, type: slug ? 'signup' : 'other' }, firstSeenAt: new Date(), lastSeenAt: new Date() });
  };
  const alertOpen = async (kind: string, dedupKey: string) => (await controlDb.select({ id: opsAlerts.id }).from(opsAlerts)
    .where(and(eq(opsAlerts.kind, kind), eq(opsAlerts.dedupKey, dedupKey), eq(opsAlerts.scope, 'global'), isNull(opsAlerts.resolvedAt)))).length > 0;
  const start = new Date();

  beforeAll(async () => { await cleanupLifecycleTenants(); });
  afterEach(() => { neonFails = false; });
  afterAll(async () => {
    if (keys.length) await controlDb.delete(opsAlerts).where(inArray(opsAlerts.dedupKey, keys));
    await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.kind, 'rebuild-original-watch'), like(opsAlerts.dedupKey, `${PREFIX}%`)));
    await controlDb.delete(disasterRuns).where(like(disasterRuns.runId, `${PREFIX}%`));
    await cleanupLifecycleTenants();
  });

  describe('T25: an open window address is taken at signup and provisioning', () => {
    it('taken while the alert is open; the provisioning path refuses it; available again once the daily check sees the project deleted', async () => {
      const slug = `test-lc-win-${randomUUID().slice(0, 6)}`;
      const projectId = key('signup');
      live.add(projectId);
      await windowAlert(projectId, slug);
      expect(await checkSlugAvailableInternal(slug)).toEqual({ available: false, reason: 'taken' });
      await expect(provisionTenant({ slug, name: 'Win Co', adminEmail: 'a@test.dev', adminName: 'a', createDatabase: async () => { throw new Error('must not be reached'); } } as Parameters<typeof provisionTenant>[0]))
        .rejects.toBeInstanceOf(ProvisionConflictError);
      // A reserved system name is "invalid", not "taken".
      expect(await checkSlugAvailableInternal('control-prod')).toEqual({ available: false, reason: 'invalid' });
      live.delete(projectId);
      expect(await syncWindowProjects(new Date(), { neon, env: ENV })).toMatchObject({ resolved: expect.any(Number) });
      expect(await alertOpen('window-project', projectId)).toBe(false);
      expect(await checkSlugAvailableInternal(slug)).toEqual({ available: true });
    });

    it('also released when the daily check sees a tenants row reference the project ("now a workspace")', async () => {
      const slug = `test-lc-win-${randomUUID().slice(0, 6)}`;
      const projectId = key('ref');
      live.add(projectId);
      await windowAlert(projectId, slug);
      const t = await makeTenant({ neonProjectId: projectId });
      await syncWindowProjects(new Date(), { neon, env: ENV });
      const [a] = await controlDb.select({ resolvedAt: opsAlerts.resolvedAt, note: opsAlerts.resolutionNote }).from(opsAlerts).where(and(eq(opsAlerts.kind, 'window-project'), eq(opsAlerts.dedupKey, projectId)));
      expect(a.resolvedAt).not.toBeNull();
      expect(a.note).toBe('now a workspace');
      invalidateTenant(slug);
      expect(await checkSlugAvailableInternal(slug)).toEqual({ available: true });
      await controlDb.delete(tenants).where(eq(tenants.id, t.id));
    });
  });

  describe('T26: the window-project daily check', () => {
    it('404 → resolved; a Neon failure → open; a live project → open; never resolved by the NEON_KINDS sweep; off where monitoring is off', async () => {
      const gone = key('gone');
      const kept = key('kept');
      const failing = key('failing');
      live.add(kept);
      live.add(failing);
      for (const id of [gone, kept, failing]) await windowAlert(id, null);
      // The NEON_KINDS sweep (the disaster sync) never touches window-project.
      await syncDisasterAlerts(new Date(), { neon, env: ENV });
      for (const id of [gone, kept, failing]) expect(await alertOpen('window-project', id), id).toBe(true);
      // Monitoring off: nothing checked.
      expect(await syncWindowProjects(new Date(), { neon, env: { BACKUPS_EXPECTED: '0' } })).toBeNull();
      expect(await alertOpen('window-project', gone)).toBe(true);
      await syncWindowProjects(new Date(), { neon, env: ENV });
      expect(await alertOpen('window-project', gone)).toBe(false);
      expect(await alertOpen('window-project', kept)).toBe(true);
      live.delete(failing);
      neonFails = true;
      await syncWindowProjects(new Date(), { neon, env: ENV });
      expect(await alertOpen('window-project', failing)).toBe(true);
    });
  });

  describe('T12 and the control-plane watch (§6.8)', () => {
    it('a rebuilt control plane (its run row and the global watch) raises nothing on the daily checks; the old one returning → the control-plane wording', async () => {
      const oldId = `${PREFIX}old-${randomUUID().slice(0, 6)}`;
      const runId = `${PREFIX}cp-${randomUUID().slice(0, 6)}`;
      const at = new Date(Date.now() - 2 * H);
      await controlDb.insert(disasterRuns).values({ runId, mode: 'control-plane', startedAt: at, finishedAt: at, status: 'pass', summary: { target: 'control-plane', previousProjectId: oldId, newProjectId: CP_ID } });
      await controlDb.insert(opsAlerts).values({ scope: 'global', tenantId: null, kind: 'rebuild-original-watch', dedupKey: oldId, detail: { kind: 'control-plane', oldProjectId: oldId, newProjectId: CP_ID, watchStartedAt: at.toISOString() }, firstSeenAt: at, lastSeenAt: at });
      await syncDisasterAlerts(new Date(), { neon, env: ENV });
      const raised = await controlDb.select({ kind: opsAlerts.kind, dedupKey: opsAlerts.dedupKey }).from(opsAlerts)
        .where(and(inArray(opsAlerts.kind, ['rebuild-orphan-project', 'rebuild-original-returned', 'rebuild-original-recoverable']), inArray(opsAlerts.dedupKey, [oldId, CP_ID])));
      expect(raised).toEqual([]);
      expect(await alertOpen('rebuild-original-watch', oldId)).toBe(true);
      // The old control plane comes back: the control-plane wording, never the workspace one.
      live.add(oldId);
      await syncDisasterAlerts(new Date(), { neon, env: ENV });
      const [ret] = await controlDb.select({ detail: opsAlerts.detail }).from(opsAlerts).where(and(eq(opsAlerts.kind, 'rebuild-original-returned'), eq(opsAlerts.dedupKey, oldId)));
      expect((ret.detail as { todo: string }).todo).toContain("the old control plane exists again: don't use it");
      live.delete(oldId);
      await controlDb.delete(opsAlerts).where(eq(opsAlerts.dedupKey, oldId));
    });
  });

  describe('T20 (the digest close) and D10 (the digest line)', () => {
    it('a stuck run closed by the daily sync keeps its target; the digest names a control-plane rehearsal', async () => {
      const stuck = `${PREFIX}stuck-${randomUUID().slice(0, 6)}`;
      await controlDb.insert(disasterRuns).values({ runId: stuck, mode: 'rehearse', startedAt: new Date(Date.now() - 6 * H), status: 'running', summary: { target: 'control-plane' } });
      await syncDisasterAlerts(new Date(), { neon, env: ENV });
      const [r] = await controlDb.select({ status: disasterRuns.status, summary: disasterRuns.summary }).from(disasterRuns).where(eq(disasterRuns.runId, stuck));
      expect(r).toMatchObject({ status: 'fail', summary: { target: 'control-plane', detail: 'abandoned' } });
      const pass = `${PREFIX}reh-${randomUUID().slice(0, 6)}`;
      await controlDb.insert(disasterRuns).values({ runId: pass, mode: 'rehearse', startedAt: new Date(), finishedAt: new Date(), status: 'pass', summary: { target: 'control-plane' } });
      expect((await disasterDigestLines(new Date())).join(' ')).toMatch(/rehearse \(control plane\) pass at/);
      // Only the stuck alert this test raised (first seen after the file started), never an older one.
      await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.kind, 'disaster-run-stuck'), eq(opsAlerts.scope, 'global'), eq(opsAlerts.dedupKey, ''), gte(opsAlerts.firstSeenAt, start)));
    });
  });
});
