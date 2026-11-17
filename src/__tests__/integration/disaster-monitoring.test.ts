import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, gte, inArray, like } from 'drizzle-orm';

/**
 * feature-plan-disaster-restore.md §11 D6/D8 against a real control plane: the daily disaster sync's SQL (facts, the
 * appended rows, the raised and resolved alerts) and the digest line. Uses the app's local control plane like 3b's S9
 * (throwaway `test-lc-*` tenants, `test-dm-` run ids; global disaster alerts first seen after this file started are
 * deleted afterwards). Neon is a fake function: no network.
 */
vi.mock('server-only', () => ({}));

import { controlDb } from '@/db/control-plane';
import { databaseBackups, disasterActions, disasterRuns, opsAlerts } from '@/db/control-plane/schema';
import { syncDisasterAlerts, disasterDigestLines, readDisasterFacts, DISASTER_ALERT_KINDS, type NeonFetch } from '@/lib/tenant/disaster-status';
import { cleanupLifecycleTenants, cpReady, makeTenant, type TenantRow } from './lifecycle-helpers';

const H = 3600_000;
const PREFIX = 'test-dm-';
const ENV = { BACKUPS_EXPECTED: '1', CONTROL_PLANE_PROJECT_ID: 'prj-cp-test' };

describe.skipIf(!cpReady)('the daily disaster sync (real SQL)', () => {
  const start = new Date();
  let a: TenantRow;
  let b: TenantRow;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const live = new Set<string>(['prj-cp-test']);
  const neon: NeonFetch = async (path) => {
    if (path.startsWith('/projects?')) return { status: 200, json: { projects: path.includes('cursor=') ? [] : [...live].map((id) => ({ id, name: id })), pagination: { cursor: 'c' } } };
    const id = decodeURIComponent(path.split('/')[2].split('?')[0]);
    return { status: live.has(id) ? 200 : 404, json: {} };
  };
  const act = (o: Partial<typeof disasterActions.$inferInsert>) => controlDb.insert(disasterActions).values({ runId: `${PREFIX}r`, kind: 'proof', status: 'gone', at: new Date(), ...o } as typeof disasterActions.$inferInsert);
  const open = async (kind: string) => (await controlDb.select({ dedupKey: opsAlerts.dedupKey, detail: opsAlerts.detail }).from(opsAlerts)
    .where(and(eq(opsAlerts.kind, kind), gte(opsAlerts.firstSeenAt, start)))).filter(Boolean);
  const openUnresolved = async (kind: string) => (await controlDb.select({ dedupKey: opsAlerts.dedupKey, resolvedAt: opsAlerts.resolvedAt }).from(opsAlerts)
    .where(and(eq(opsAlerts.kind, kind), gte(opsAlerts.firstSeenAt, start)))).filter((x) => x.resolvedAt === null).map((x) => x.dedupKey);

  const clean = async () => {
    await controlDb.delete(disasterActions).where(like(disasterActions.runId, `${PREFIX}%`));
    await controlDb.delete(disasterActions).where(like(disasterActions.runId, 'digest-%'));
    await controlDb.delete(disasterRuns).where(like(disasterRuns.runId, `${PREFIX}%`));
    await controlDb.delete(databaseBackups).where(like(databaseBackups.runId, `${PREFIX}%`));
    await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.scope, 'global'), inArray(opsAlerts.kind, [...DISASTER_ALERT_KINDS]), gte(opsAlerts.firstSeenAt, start)));
  };
  beforeAll(async () => {
    await cleanupLifecycleTenants();
    await clean();
    a = await makeTenant({ slug: `test-lc-dma-${Date.now() % 100000}`, status: 'active', neonProjectId: 'prj-a-now' });
    b = await makeTenant({ slug: `test-lc-dmb-${Date.now() % 100000}`, status: 'active' });
  });
  afterAll(async () => {
    await clean();
    await cleanupLifecycleTenants();
  });

  it('skip → 3b ok after it → workspace-needs-deploy; a later migration resolves it. A rebuild (linked ≥ 1 h) with no deploy → raised; resolved by the deploy\'s migrated row', async () => {
    await act({ tenantId: a.id, kind: 'skip', status: 'skipped', at: ago(30 * H) });
    await controlDb.insert(databaseBackups).values({ tenantId: a.id, target: 'tenant', runId: `${PREFIX}b`, status: 'ok', targetDeadlineMs: 1, startedAt: ago(10 * H), finishedAt: ago(10 * H) });
    await act({ tenantId: b.id, kind: 'rebuild', status: 'linked', projectName: 'cadenzpoint-r-x-1', newProjectId: 'prj-b-new', oldProjectId: 'prj-b-old', at: ago(2 * H) });
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect((await openUnresolved('workspace-needs-deploy')).sort()).toEqual([a.id, b.id].sort());
    const [one] = await open('workspace-needs-deploy');
    expect(one.detail).toMatchObject({ todo: 'run Deploy to Production (normal) now' });
    // The deploy (migrate-all) writes `migrated` rows: both resolve on the next sync.
    await act({ tenantId: a.id, kind: 'skip', status: 'migrated', at: new Date() });
    await act({ tenantId: b.id, kind: 'skip', status: 'migrated', at: new Date() });
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect(await openUnresolved('workspace-needs-deploy')).toEqual([]);
  });

  it('a leftover alive → rebuild-orphan-project; once it 404s → resolved and gone-confirmed appended (not re-checked); a referenced `failed` one is healed to linked with a watch', async () => {
    live.add('prj-left');
    await act({ tenantId: a.id, kind: 'rebuild', status: 'intended', projectName: 'cadenzpoint-r-left-1', oldProjectId: 'prj-a-old', at: ago(8 * H) });
    await act({ tenantId: a.id, kind: 'rebuild', status: 'created', projectName: 'cadenzpoint-r-left-1', newProjectId: 'prj-left', oldProjectId: 'prj-a-old', at: ago(8 * H - 1000) });
    await act({ tenantId: a.id, kind: 'rebuild', status: 'failed', projectName: 'cadenzpoint-r-heal-1', newProjectId: 'prj-a-now', oldProjectId: 'prj-a-old', at: ago(7 * H) });
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect(await openUnresolved('rebuild-orphan-project')).toEqual(['prj-left']);
    const healed = await controlDb.select({ status: disasterActions.status }).from(disasterActions).where(eq(disasterActions.projectName, 'cadenzpoint-r-heal-1'));
    expect(healed.map((x) => x.status)).toEqual(['failed', 'linked']);
    expect(await openUnresolved('rebuild-original-watch')).toContain('prj-a-old');
    live.delete('prj-left');
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect(await openUnresolved('rebuild-orphan-project')).toEqual([]);
    const left = await controlDb.select({ status: disasterActions.status }).from(disasterActions).where(eq(disasterActions.projectName, 'cadenzpoint-r-left-1'));
    expect(left.map((x) => x.status)).toEqual(['intended', 'created', 'gone-confirmed']);
  });

  it('a run running for over 345 minutes → disaster-run-stuck and closed as abandoned in the same sync; the next day it resolves', async () => {
    await controlDb.insert(disasterRuns).values({ runId: `${PREFIX}stuck`, mode: 'workspace', startedAt: ago(6 * H), status: 'running' });
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect(await openUnresolved('disaster-run-stuck')).toEqual(['']);
    const [r] = await controlDb.select({ status: disasterRuns.status, summary: disasterRuns.summary }).from(disasterRuns).where(eq(disasterRuns.runId, `${PREFIX}stuck`));
    expect(r).toMatchObject({ status: 'fail', summary: { detail: 'abandoned' } });
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect(await openUnresolved('disaster-run-stuck')).toEqual([]);
  });

  it('the original returns (200) → rebuild-original-returned; 404 → resolved; a personal key (control-plane project not listed) → rebuild-watch-check-failed', async () => {
    live.add('prj-a-old');
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect(await openUnresolved('rebuild-original-returned')).toEqual(['prj-a-old']);
    live.delete('prj-a-old');
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect(await openUnresolved('rebuild-original-returned')).toEqual([]);
    await syncDisasterAlerts(new Date(), { neon, env: { ...ENV, CONTROL_PLANE_PROJECT_ID: 'prj-not-visible' } });
    expect(await openUnresolved('rebuild-watch-check-failed')).toEqual(['']);
    await syncDisasterAlerts(new Date(), { neon, env: ENV });
    expect(await openUnresolved('rebuild-watch-check-failed')).toEqual([]);
  });

  it('monitoring not on (BACKUPS_EXPECTED unset or 0): nothing runs', async () => {
    expect(await syncDisasterAlerts(new Date(), { neon, env: { BACKUPS_EXPECTED: '0' } })).toEqual({ synced: false, findings: 0 });
  });

  it('the digest line lists the last 7 days\' runs; the facts reader sees the test rows', async () => {
    await controlDb.insert(disasterRuns).values({ runId: `${PREFIX}reh`, mode: 'rehearse', startedAt: ago(H), finishedAt: ago(H / 2), status: 'pass' });
    const lines = await disasterDigestLines(new Date());
    expect(lines[0]).toMatch(/^Disaster runs in the last 7 days: .*rehearse pass at /);
    const f = await readDisasterFacts(new Date());
    expect(f.runs.some((r) => r.runId === `${PREFIX}reh`)).toBe(true);
  });
});
