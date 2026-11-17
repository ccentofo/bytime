import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CAN_RUN, createWorld, press, tenantRow, actions, fakeEcs, type World, type WorldTenant } from './disaster-harness';
import { neonApi, type NeonApi } from '../../../scripts/backup/lib/neon-api';
import { poolerOf } from '../helpers/fake-neon';

/**
 * feature-plan-disaster-restore.md §11 R6 (and R5b's schedule half): mode `rehearse` end to end. No switch; the copy
 * deleted, seen in the recoverable list, its deleted endpoint classified "doesn't answer" (the local 28P01 stand-in, as
 * Neon's proxy); the canary checks; `auto`; a rehearsal that fails mid-restore still deletes its project.
 */

describe.skipIf(!CAN_RUN)('R6: rehearse', () => {
  let w: World;
  let next = 0;
  const take = (): WorldTenant => w.tenants[next++];
  const createdFor = (t: WorldTenant) => [...w.neon.projects.values()].filter((p) => p.name.startsWith(`cadenzpoint-r-${t.id.slice(0, 8)}-`));
  const rehearse = (targets: string[] | 'auto', over: Parameters<typeof press>[2] = {}, override: 'none' | 'canary' = 'none') =>
    press(w, { mode: 'rehearse', targets, override }, { ecs: fakeEcs({ startedBy: 'chronos-schedule/cadenzpoint-backup-disaster-rehearse' }), ...over });

  beforeAll(async () => { w = await createWorld(14, 'test-dr-rh'); }, 180_000);
  afterAll(async () => { await w?.close(); });

  it('a rehearsal from the schedule runs: the full proof against the live original (rehearse-ok), a restore with exact counts, NO switch, the copy deleted and seen recoverable, its endpoint "doesn\'t answer" with the SQLSTATE recorded', async () => {
    const t = take();
    const before = await tenantRow(w, t.id);
    const r = await rehearse([t.id]);
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    const after = await tenantRow(w, t.id);
    expect(after).toEqual(before); // the row is unchanged, byte for byte
    const acts = await actions(w, t.id);
    expect(acts.map((a) => `${a.kind}:${a.status}`)).toEqual(['proof:rehearse-ok', 'rehearse:intended', 'rehearse:created', 'rehearse:deleted', 'rehearse:rehearsed-deleted']);
    expect(acts.at(-1)!.detail).toMatch(/^deleted endpoint: doesn't answer \(28P01\) after \d+ s$/);
    expect(createdFor(t)).toHaveLength(1);
    expect(createdFor(t)[0].deleted).toBe(true);
    expect((await w.cpSql`SELECT count(*)::int AS n FROM tenant_audit_events WHERE tenant_id = ${t.id}`)[0].n).toBe(0);
    expect((await w.cpSql`SELECT count(*)::int AS n FROM ops_alerts WHERE kind LIKE 'rebuild-%' AND detail->>'tenantId' = ${t.id}`)[0].n).toBe(0);
    expect(r.emails[0].message).toContain('Disaster rehearsal passed');
    expect(r.emails[0].message).toContain('No workspace was changed.');
    const [run] = await w.cpSql`SELECT status, mode FROM disaster_runs WHERE run_id = ${r.args.runId}`;
    expect(run).toEqual({ status: 'pass', mode: 'rehearse' });
  }, 60_000);

  it('the canary (the founder\'s first rehearsal): seen in the recoverable list and GET → 404 → passes; missing → fails before any project is created', async () => {
    const t = take();
    expect((await rehearse([t.id], {}, 'canary')).exitCode).toBe(1);
    expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:proof-failed']);
    expect(createdFor(t)).toEqual([]);
    w.neon.addProject({ name: 'cadenzpoint-recoverable-canary', deleted: true });
    const ok = await rehearse([t.id], {}, 'canary');
    expect(ok.exitCode, ok.logs.join('\n')).toBe(0);
    expect((await actions(w, t.id)).find((a) => a.status === 'rehearse-ok')!.detail).toBe('canary seen in the recoverable list; GET 404');
  }, 60_000);

  it('the recoverable list must be returned completely, and the original must answer 200', async () => {
    const t = take();
    w.neon.unavailable = { ids: ['prj-x'], calls: 1 };
    expect((await rehearse([t.id])).exitCode).toBe(1);
    w.neon.purge(t.projectId);
    expect((await rehearse([t.id])).exitCode).toBe(1);
    expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:proof-failed', 'refused:proof-failed']);
  });

  it('a rehearsal that fails mid-restore still deletes its project', async () => {
    const t = take();
    const r = await rehearse([t.id], { pgRestoreBin: '/usr/bin/false' });
    expect(r.exitCode).toBe(1);
    expect(createdFor(t)).toHaveLength(1);
    expect(createdFor(t)[0].deleted).toBe(true);
  });

  it('auto prefers the `rehearsal` workspace, else a live one with a recent ok backup; none eligible → the rehearsal fails "no eligible workspace"', async () => {
    const t = take();
    await w.cpSql`UPDATE tenants SET slug = 'rehearsal' WHERE id = ${t.id}`;
    const r = await rehearse('auto');
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    expect(r.outcome!.results[0].tenantId).toBe(t.id);
    // Without a recent ok backup anywhere: nobody is eligible.
    await w.cpSql`UPDATE database_backups SET finished_at = now() - interval '3 days'`;
    const none = await rehearse('auto');
    expect(none.exitCode).toBe(1);
    expect(none.emails[0].message).toContain('no eligible workspace');
    const [run] = await w.cpSql`SELECT status FROM disaster_runs WHERE run_id = ${none.args.runId}`;
    expect(run.status).toBe('fail');
  }, 60_000);

  describe('fix round 1 (FR4: M66, M67, M68, M86)', () => {
    const api = (): NeonApi => neonApi({ apiKey: w.neon.apiKey, orgId: w.neon.orgId, baseUrl: w.neon.url, sleep: async () => {}, operationPollMs: 1 });
    const fast = { recoverablePolls: 2, recoverablePollMs: 5, overrideGapMs: 5, lockRetryMs: 20, cleanupRetryMs: 20, deletedEndpointWaitMs: 50, deletedEndpointPollMs: 10 };

    it('M66: the deleted copy\'s endpoint served by a live project → the rehearsal fails (the real proof would misjudge)', async () => {
      const t = take();
      const base = api();
      const neon: NeonApi = {
        ...base,
        async deleteProject(id) {
          const host = w.neon.projects.get(id)!.endpoints[0].host;
          await base.deleteProject(id);
          w.neon.addProject({ name: `cadenzpoint-${t.slug}`, host, mapTo: { host: w.proxy.host, port: w.proxy.port } });
          w.neon.hostMap[poolerOf(host)] = { host: w.proxy.host, port: w.proxy.port };
        },
      };
      const r = await rehearse([t.id], { neon, timing: fast });
      expect(r.exitCode).toBe(1);
      expect(r.outcome!.results[0].detail).toContain('still classifies "served"');
      expect((await actions(w, t.id)).at(-1)).toMatchObject({ kind: 'rehearse', status: 'failed' });
    }, 60_000);

    it('M66: an unproven deleted-endpoint check (a partial candidate list) → the rehearsal fails', async () => {
      const t = take();
      const base = api();
      let deleted = false;
      const neon: NeonApi = {
        ...base,
        async deleteProject(id) { await base.deleteProject(id); deleted = true; },
        async listProjects(q = {}) { const l = await base.listProjects(q); return deleted && q.search ? { ...l, unavailable: ['prj-slow'] } : l; },
      };
      const r = await rehearse([t.id], { neon, timing: fast });
      expect(r.exitCode).toBe(1);
      expect(r.outcome!.results[0].detail).toContain('still classifies "unproven"');
    }, 60_000);

    it('M67: a canary that answers 200 → fails before any project is created', async () => {
      const t = take();
      w.neon.addProject({ name: 'cadenzpoint-recoverable-canary', deleted: true });
      // Every canary answers 200 here (an earlier test may have left one too: the name lookup may pick either).
      const canaries = () => new Set([...w.neon.projects.values()].filter((p) => p.name === 'cadenzpoint-recoverable-canary').map((p) => p.id));
      const base = api();
      const neon: NeonApi = { ...base, async getProject(id) { return canaries().has(id) ? { found: true, project: { id, name: 'cadenzpoint-recoverable-canary' } } : base.getProject(id); } };
      const r = await rehearse([t.id], { neon }, 'canary');
      expect(r.exitCode).toBe(1);
      expect(r.outcome!.results[0].detail).toContain('the canary answers 200');
      expect(createdFor(t)).toEqual([]);
    });

    it('M68: the deleted copy missing from the recoverable list → the rehearsal fails', async () => {
      const t = take();
      const base = api();
      const neon: NeonApi = {
        ...base,
        async listProjects(q = {}) {
          const l = await base.listProjects(q);
          return q.recoverable ? { ...l, projects: l.projects.filter((p) => !p.name.startsWith(`cadenzpoint-r-${t.id.slice(0, 8)}-`)) } : l;
        },
      };
      const r = await rehearse([t.id], { neon, timing: fast });
      expect(r.exitCode).toBe(1);
      expect(r.outcome!.results[0].detail).toContain("didn't appear in this key's recoverable list");
    }, 60_000);

    it('M86: the positive control is never skipped: a complete list that doesn\'t contain any known project → fails before any project is created', async () => {
      const t = take();
      const base = api();
      const neon: NeonApi = { ...base, async listProjects(q = {}) { return !q.search && !q.recoverable ? { projects: [], unavailable: [] } : base.listProjects(q); } };
      const r = await rehearse([t.id], { neon });
      expect(r.exitCode).toBe(1);
      expect(r.outcome!.results[0].detail).toContain('the positive control failed');
      expect(createdFor(t)).toEqual([]);
    });
  });
});
