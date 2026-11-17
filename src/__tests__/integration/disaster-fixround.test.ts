import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CAN_RUN, createWorld, press, makeGone, tenantRow, actions, type World, type WorldTenant } from './disaster-harness';
import { neonApi, NeonApiError, type NeonApi } from '../../../scripts/backup/lib/neon-api';
import { DUMP_SUFFIX, sidecarKeyFor, targetPrefix } from '../../../scripts/backup/lib/keys';
import { summarizeError } from '../../../scripts/backup/lib/summarize-error';
import { startFakePgProxy, type FakePgProxy } from '../helpers/fake-pg-proxy';
import { fakeHost, poolerOf } from '../helpers/fake-neon';

/**
 * feature-plan-disaster-restore.md, 3c fix round 1 (DISASTER-RESTORE-AUDIT.md §5): FR1, FR5, FR9, FR11 and the
 * restore-task mutations auditor A found uncaught (FR4: M09/M15/M16/M18/M19/M20/M30/M31/M32/M44/M48/M57). Each test takes
 * its own throwaway tenant in a scratch world (never the developer's control plane, never a remote database).
 */

const HOUR = 3600_000;

describe.skipIf(!CAN_RUN)('3c fix round 1: the restore task', () => {
  let w: World;
  let closer: FakePgProxy;
  let next = 0;
  const take = (): WorldTenant => w.tenants[next++];
  const createdFor = (t: WorldTenant) => [...w.neon.projects.values()].filter((p) => p.name.startsWith(`cadenzpoint-r-${t.id.slice(0, 8)}-`));
  const api = (): NeonApi => neonApi({ apiKey: w.neon.apiKey, orgId: w.neon.orgId, baseUrl: w.neon.url, sleep: async () => {}, operationPollMs: 1 });
  const local = () => { const u = new URL(process.env.CONTROL_PLANE_DATABASE_URL!); return { host: u.hostname, port: Number(u.port || 5432) }; };
  const mapHost = (host: string, to: { host: string; port: number }) => { w.neon.hostMap[host] = to; w.neon.hostMap[poolerOf(host)] = to; };
  /** The original project stays (200) but its endpoint is gone: the stored host now answers 28P01. */
  const endpointGone = (t: WorldTenant) => {
    w.neon.projects.get(t.projectId)!.endpoints = [{ id: 'ep-new', host: fakeHost() }];
    mapHost(t.host, { host: w.proxy.host, port: w.proxy.port });
  };
  const later = (h: number) => () => new Date(Date.now() + h * HOUR);
  /** A NeonApi whose listEndpoints(new project) runs `fn` first: "at the guards", just before the re-check. */
  const atGuards = (t: WorldTenant, fn: () => void | Promise<void>, base: NeonApi = api()): NeonApi => ({
    ...base,
    async listEndpoints(id) {
      if (createdFor(t).some((p) => p.id === id)) await fn();
      return base.listEndpoints(id);
    },
  });

  beforeAll(async () => {
    w = await createWorld(40, 'test-dr-fr');
    closer = await startFakePgProxy({ kind: 'close' });
  }, 240_000);
  afterAll(async () => { await closer?.close(); await w?.close(); });

  it('FR1: an override press whose project is actually gone (404) takes the gone proof, re-checks "still gone", links, and raises no `returned`', async () => {
    const t = take();
    makeGone(w, t);
    const r = await press(w, { targets: [t.id], override: 'unreachable-4h' });
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    expect((await actions(w, t.id)).map((a) => `${a.kind}:${a.status}`)).toEqual(['proof:gone', 'rebuild:intended', 'rebuild:created', 'rebuild:linked']);
    expect((await w.cpSql`SELECT 1 FROM ops_alerts WHERE kind = 'rebuild-original-returned' AND dedup_key = ${t.projectId}`).length).toBe(0);
    expect((await w.cpSql`SELECT 1 FROM ops_alerts WHERE kind = 'rebuild-original-watch' AND dedup_key = ${t.projectId}`).length).toBe(1);
    const [audit] = await w.cpSql`SELECT detail FROM tenant_audit_events WHERE tenant_id = ${t.id} AND kind = 'database-rebuilt'`;
    expect(JSON.parse(audit.detail).override).toBe(false);
  }, 60_000);

  it('FR5: a stop during the re-check never reaches the switch: not linked, the project cleaned up', async () => {
    const t = take();
    makeGone(w, t);
    const stop = new AbortController();
    const base = api();
    let calls = 0;
    const neon: NeonApi = { ...base, async getProject(id) { if (id === t.projectId && ++calls === 2) stop.abort('stopped'); return base.getProject(id); } };
    const r = await press(w, { targets: [t.id] }, { neon, stopSignal: stop.signal });
    expect(r.outcome!.results[0].result).toBe('not-finished');
    expect((await tenantRow(w, t.id)).neonProjectId).toBe(t.projectId);
    expect(createdFor(t).every((p) => p.deleted)).toBe(true);
    expect((await actions(w, t.id)).some((a) => a.status === 'linked')).toBe(false);
  }, 60_000);

  it('FR9: all-lost reports every workspace whose project lookup failed as proof-failed ("press again"); the run is not a pass', async () => {
    const base = api();
    const failing: NeonApi = { ...base, async getProject() { throw new NeonApiError('get-project', 503, null); } };
    const r = await press(w, { targets: 'all-lost' }, { neon: failing });
    expect(r.exitCode).toBe(1);
    const live = (await w.cpSql`SELECT count(*)::int AS n FROM tenants WHERE status = 'active' AND neon_project_id IS NOT NULL`)[0].n;
    expect(r.outcome!.results.length).toBe(live);
    expect(r.outcome!.results.every((x) => x.result === 'proof-failed')).toBe(true);
    expect(r.emails[0].message).toContain('press again');
    expect(r.emails[0].message).not.toContain('No workspace is proven lost');
  }, 60_000);

  it('FR11: a schema note whose connections hang (a server closing during startup) is skipped with a log line; the run and the email still complete', async () => {
    const t = take();
    makeGone(w, t);
    const others = w.tenants.filter((x) => x.id !== t.id);
    const saved = others.map((o) => [o.host, w.neon.hostMap[o.host]] as const);
    const t0 = Date.now();
    try {
      const r = await press(w, { targets: [t.id] }, {
        timing: { recoverablePolls: 2, recoverablePollMs: 5, overrideGapMs: 5, lockRetryMs: 20, cleanupRetryMs: 20, schemaNoteTimeoutSeconds: 1 },
        hooks: { afterCommit: async () => { for (const o of others) mapHost(o.host, { host: closer.host, port: closer.port }); } },
      });
      expect(r.exitCode, r.logs.join('\n')).toBe(0);
      expect(r.outcome!.results[0].detail).toBe('no other workspace was reachable: run Deploy to Production now to be safe');
      expect(r.logs.some((l) => /^schema note: workspace \S+ didn't answer; skipped$/.test(l))).toBe(true);
      expect(r.emails).toHaveLength(1);
      expect(Date.now() - t0).toBeLessThan(30_000);
    } finally {
      for (const [h, m] of saved) mapHost(h, m);
    }
  }, 60_000);

  it('M20: the override classifies twice: unreachable, then answering at the second look → refused:reachable', async () => {
    const t = take();
    endpointGone(t);
    await press(w, { targets: [t.id], override: 'unreachable-4h' }); // observed
    const r = await press(w, { targets: [t.id], override: 'unreachable-4h' }, {
      now: later(5),
      timing: { recoverablePolls: 2, recoverablePollMs: 5, overrideGapMs: 7, lockRetryMs: 20, cleanupRetryMs: 20 },
      sleep: async (ms) => {
        if (ms === 7) { w.neon.projects.get(t.projectId)!.endpoints = [{ id: 'ep-x', host: t.host }]; mapHost(t.host, local()); }
        await new Promise((res) => setTimeout(res, ms));
      },
    });
    expect(r.outcome!.results[0].result).toBe('reachable');
    expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['observed-unreachable', 'refused:reachable']);
  }, 60_000);

  it('M30: an observation of a DIFFERENT original (old_project_id) is never evidence', async () => {
    const t = take();
    endpointGone(t);
    await w.cpSql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, old_project_id, at) VALUES ('gh-o-1', ${t.id}, 'proof', 'observed-unreachable', 'prj-some-other-original', now() - interval '5 hours')`;
    const r = await press(w, { targets: [t.id], override: 'unreachable-4h' });
    expect(r.outcome!.results[0].result).toBe('observed');
  });

  it('M15/M16: a partial recoverable list, or a failed poll → proof-failed (never "not recoverable")', async () => {
    for (const listRec of [
      async () => ({ projects: [], unavailable: ['prj-slow'] }),
      async () => { throw new NeonApiError('list-projects', 503, null); },
    ]) {
      const t = take();
      makeGone(w, t);
      const base = api();
      const neon: NeonApi = { ...base, async listProjects(q = {}) { return q.recoverable ? listRec() : base.listProjects(q); } };
      const r = await press(w, { targets: [t.id] }, { neon });
      expect(r.outcome!.results[0].result).toBe('proof-failed');
      expect(createdFor(t)).toEqual([]);
    }
  }, 60_000);

  it('M18/M19: network first: no other database answers (every workspace and the control plane) → network-unproven, on the gone path and on the override path', async () => {
    const proxyTarget = { host: w.proxy.host, port: w.proxy.port };
    const deadMap: Record<string, { host: string; port: number }> = { ...w.neon.hostMap, localhost: proxyTarget, '127.0.0.1': proxyTarget };
    for (const o of w.tenants) { deadMap[o.host] = proxyTarget; deadMap[poolerOf(o.host)] = proxyTarget; }
    const g = take();
    makeGone(w, g);
    const r1 = await press(w, { targets: [g.id] }, { hostMap: deadMap });
    expect(r1.outcome!.results[0].result).toBe('network-unproven');
    expect((await actions(w, g.id)).map((a) => a.status)).toEqual(['refused:network-unproven']);
    const o = take();
    endpointGone(o);
    const r2 = await press(w, { targets: [o.id], override: 'unreachable-4h' }, { hostMap: deadMap });
    expect(r2.outcome!.results[0].result).toBe('network-unproven');
    expect((await actions(w, o.id)).map((a) => a.status)).toEqual(['refused:network-unproven']); // no observation recorded
  }, 60_000);

  it('M31/M32: the gone re-check refuses a recoverable original, a served address, and an unproven address check', async () => {
    const cases: Array<(t: WorldTenant) => void | Promise<void>> = [
      (t) => { w.neon.addProject({ id: t.projectId, name: `cadenzpoint-${t.slug}`, deleted: true }); },
      (t) => { w.neon.addProject({ name: `cadenzpoint-${t.slug}`, host: t.host, mapTo: { host: w.proxy.host, port: w.proxy.port } }); },
      () => { w.neon.unavailable = { ids: ['prj-slow'], calls: 50 }; },
    ];
    for (const flip of cases) {
      const t = take();
      makeGone(w, t);
      const r = await press(w, { targets: [t.id] }, { neon: atGuards(t, () => flip(t)) });
      w.neon.unavailable = { ids: [], calls: 0 };
      expect(r.outcome!.results[0].result).toBe('original-back');
      expect((await tenantRow(w, t.id)).neonProjectId).toBe(t.projectId);
      expect(createdFor(t).every((p) => p.deleted)).toBe(true);
    }
  }, 90_000);

  it('M44: a delete is confirmed only by a 404: a project that still answers after DELETE is kept and recorded `failed`', async () => {
    const t = take();
    makeGone(w, t);
    w.neon.script('GET /projects/:id/endpoints', [503]); // the guards fail → cleanup
    const base = api();
    const neon: NeonApi = { ...base, async deleteProject() { /* accepted, but nothing happens */ } };
    const r = await press(w, { targets: [t.id] }, { neon });
    expect(r.outcome!.results[0].result).toBe('guard');
    const last = (await actions(w, t.id)).at(-1)!;
    expect(last).toMatchObject({ status: 'failed' });
    expect(last.detail).toContain('still answers after DELETE');
    expect(createdFor(t)[0].deleted).toBe(false);
  });

  it('M48: at most 3 candidates are tried: 4 that all fail verification → exactly 3 projects, then no-backup', async () => {
    const t = take();
    makeGone(w, t);
    const prefix = targetPrefix(w.cpId, 'tenant', t.id);
    const keys = [...w.bucket.objects.keys()].filter((k) => k.startsWith(prefix) && k.endsWith(DUMP_SUFFIX));
    const [row] = await w.cpSql`SELECT sha256, row_counts AS "rowCounts" FROM database_backups WHERE s3_key = ${keys[0]}`;
    for (let i = 0; i < 2; i++) {
      // Copies under new keys: the encryption context names the original key, so each copy fails the header check.
      const copy = keys[0].replace(/-([a-z0-9]{8})\.dump\.enc$/, `-cpy${i}xxxx.dump.enc`);
      w.bucket.objects.set(copy, { ...w.bucket.objects.get(keys[0])!, lastModified: new Date() });
      w.bucket.objects.set(sidecarKeyFor(copy), { ...w.bucket.objects.get(sidecarKeyFor(keys[0]))! });
      await w.cpSql`INSERT INTO database_backups (tenant_id, target, run_id, status, s3_key, sha256, row_counts, target_deadline_ms, started_at, finished_at)
        VALUES (${t.id}, 'tenant', 'test-copy', 'ok', ${copy}, ${row.sha256}, ${w.cpSql.json(row.rowCounts)}, 1800000, now(), now())`;
    }
    for (const k of keys) { const o = w.bucket.objects.get(k)!; o.bytes = Buffer.from(o.bytes); o.bytes[o.bytes.length - 40] ^= 0xff; }
    const r = await press(w, { targets: [t.id] });
    expect(r.outcome!.results[0].result).toBe('no-backup');
    expect((await actions(w, t.id)).filter((a) => a.status === 'intended')).toHaveLength(3);
  }, 90_000);

  it('M57: the final run update never overwrites a row the digest already closed', async () => {
    const t = take();
    makeGone(w, t);
    let runId = '';
    const r = await press(w, { targets: [t.id] }, {
      hooks: { afterCommit: async () => { await w.cpSql`UPDATE disaster_runs SET status = 'fail', finished_at = now(), summary = '{"detail":"abandoned"}'::jsonb WHERE status = 'running' RETURNING run_id`.then((x) => { runId = x[0]?.run_id; }); } },
    });
    expect(r.outcome!.results[0].result).toBe('linked');
    const [run] = await w.cpSql`SELECT status, summary FROM disaster_runs WHERE run_id = ${runId}`;
    expect(run).toEqual({ status: 'fail', summary: { detail: 'abandoned' } });
  }, 60_000);

  it('FR8 (healed): a lost commit acknowledgement → the healed LINKED line and linked row carry the backup key, the SHA-256 and the backup time', async () => {
    const t = take();
    makeGone(w, t);
    const r = await press(w, { targets: [t.id] }, { hooks: { afterCommit: async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); } } });
    expect(r.outcome!.results[0].result).toBe('linked');
    const line = r.logs.find((l) => l.endsWith('(healed by the re-read)'))!;
    expect(line).toMatch(new RegExp(`^LINKED ${t.id} ${t.projectId} prj-\\S+ v1/\\S+\\.dump\\.enc [0-9a-f]{64} \\(healed by the re-read\\)$`));
    const [healed] = await w.cpSql`SELECT backup_key AS "backupKey", backup_started_at AS "backupStartedAt" FROM disaster_actions WHERE tenant_id = ${t.id} AND status = 'linked' AND detail = 'healed: the switch committed'`;
    expect(healed.backupKey).toMatch(/\.dump\.enc$/);
    expect(healed.backupStartedAt).toBeInstanceOf(Date);
  }, 60_000);

  it('the 3b evidence still works after FR1 (override proof → override re-check → linked with `returned`)', async () => {
    const t = take();
    endpointGone(t);
    await w.cpSql`UPDATE database_backups SET finished_at = now() - interval '20 hours', started_at = now() - interval '20 hours' WHERE tenant_id = ${t.id} AND status = 'ok'`;
    const err = summarizeError('connect', new Error("Couldn't connect to compute node"));
    for (const [run, h] of [['test-fa', 14], ['test-fb', 2]] as const) {
      await w.cpSql`INSERT INTO database_backups (tenant_id, target, run_id, status, target_deadline_ms, error, started_at, finished_at)
        VALUES (${t.id}, 'tenant', ${run}, 'failed', 1800000, ${err}, now() - ${`${h} hours`}::interval, now() - ${`${h} hours`}::interval)`;
    }
    const r = await press(w, { targets: [t.id], override: 'unreachable-4h' });
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    expect((await w.cpSql`SELECT 1 FROM ops_alerts WHERE kind = 'rebuild-original-returned' AND dedup_key = ${t.projectId}`).length).toBe(1);
  }, 60_000);
});
