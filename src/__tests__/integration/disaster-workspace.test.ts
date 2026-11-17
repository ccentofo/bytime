import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { decrypt, encrypt } from '@/lib/encryption';
import { CAN_RUN, createWorld, press, makeGone, tenantRow, actions, fakeEcs, fakeLogReader, type World, type WorldTenant } from './disaster-harness';
import { withDatabase } from '../../../scripts/backup/lib/pg-url';
import { neonApi, type NeonApi } from '../../../scripts/backup/lib/neon-api';
import { targetPrefix } from '../../../scripts/backup/lib/keys';
import { summarizeError } from '../../../scripts/backup/lib/summarize-error';
import { fakeHost, poolerOf } from '../helpers/fake-neon';

/**
 * feature-plan-disaster-restore.md §11 R1–R5, R5b and the mode-workspace parts of D3, D4, D8: the real `disaster
 * workspace` path end to end against a scratch control plane, real backups, real pg_restore 16, the fake Neon API and
 * the local 28P01 proxy stand-in. Each test takes its own throwaway tenant.
 */

const HOUR = 3600_000;

describe.skipIf(!CAN_RUN)('disaster workspace', () => {
  let w: World;
  let next = 0;
  const take = (): WorldTenant => w.tenants[next++];

  beforeAll(async () => { w = await createWorld(40, 'test-dr'); }, 240_000);
  afterAll(async () => { await w?.close(); });

  const slugsIn = (text: string) => w.tenants.map((t) => t.slug).filter((s) => text.includes(s));
  const api = (): NeonApi => neonApi({ apiKey: w.neon.apiKey, orgId: w.neon.orgId, baseUrl: w.neon.url, sleep: async () => {}, operationPollMs: 1 });
  /** Projects this task created for a tenant, by name, and whether each still exists (not deleted) in the fake. */
  const createdFor = (t: WorldTenant) => [...w.neon.projects.values()].filter((p) => p.name.startsWith(`cadenzpoint-r-${t.id.slice(0, 8)}-`));
  const expectUnchanged = async (t: WorldTenant, before: Awaited<ReturnType<typeof tenantRow>>) => {
    const after = await tenantRow(w, t.id);
    expect(after.neonProjectId).toBe(before.neonProjectId);
    expect(after.dbUrlEncrypted).toBe(before.dbUrlEncrypted);
    expect(after.lifecycleVersion).toBe(before.lifecycleVersion);
  };
  const keysOf = (t: WorldTenant) => [...w.bucket.objects.keys()].filter((k) => k.startsWith(targetPrefix(w.cpId, 'tenant', t.id)) && k.endsWith('.dump.enc'))
    .sort((a, b) => w.bucket.objects.get(b)!.lastModified.getTime() - w.bucket.objects.get(a)!.lastModified.getTime());

  it('R1: a gone workspace is rebuilt end to end: exact counts, the row switched, audit/linked/watch/LINKED, the original untouched, no migrations; the email has the backup time and A.7; stdout has no slug', async () => {
    const t = take();
    makeGone(w, t);
    const before = await tenantRow(w, t.id);
    const r = await press(w, { targets: [t.id] });
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    const after = await tenantRow(w, t.id);
    expect(after.neonProjectId).not.toBe(t.projectId);
    expect(after.lifecycleVersion).toBe(before.lifecycleVersion + 1);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(decrypt(after.dbUrlEncrypted!)).toContain('-pooler.us-east-1.aws.neon.tech');
    const created = w.neon.projects.get(after.neonProjectId!)!;
    expect(created.name).toMatch(new RegExp(`^cadenzpoint-r-${t.id.slice(0, 8)}-\\d{14}-1$`));
    expect(created.name.length).toBeLessThanOrEqual(40);
    const db = postgres(withDatabase(process.env.CONTROL_PLANE_DATABASE_URL!, created.localDb!), { max: 1, onnotice: () => {} });
    try {
      expect((await db`SELECT count(*)::int AS n FROM users`)[0].n).toBe(25);
      expect((await db`SELECT count(*)::int AS n FROM timesheet_entries`)[0].n).toBe(400);
      expect((await db`SELECT count(*)::int AS n FROM audit.events`)[0].n).toBe(7);
      expect((await db`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`)[0].t).toBeNull(); // the button never migrates
    } finally {
      await db.end({ timeout: 5 });
    }
    const orig = postgres(w.original.url, { max: 1, onnotice: () => {} });
    try { expect((await orig`SELECT count(*)::int AS n FROM users`)[0].n).toBe(25); } finally { await orig.end({ timeout: 5 }); }
    const acts = await actions(w, t.id);
    expect(acts.map((a) => `${a.kind}:${a.status}`)).toEqual(['proof:gone', 'rebuild:intended', 'rebuild:created', 'rebuild:linked']);
    const [audit] = await w.cpSql`SELECT kind, actor, detail FROM tenant_audit_events WHERE tenant_id = ${t.id}`;
    expect(audit).toMatchObject({ kind: 'database-rebuilt', actor: `disaster:${r.args.runId}` });
    expect(JSON.parse(audit.detail)).toMatchObject({ oldProjectId: t.projectId, newProjectId: after.neonProjectId, override: false });
    const [watch] = await w.cpSql`SELECT scope, detail FROM ops_alerts WHERE kind = 'rebuild-original-watch' AND dedup_key = ${t.projectId}`;
    expect(watch.scope).toBe('global');
    expect(watch.detail).toMatchObject({ tenantId: t.id, slug: t.slug });
    expect((await w.cpSql`SELECT 1 FROM ops_alerts WHERE kind = 'rebuild-original-returned' AND dedup_key = ${t.projectId}`).length).toBe(0);
    const sw = r.logs.findIndex((l) => l.startsWith(`SWITCHING ${t.id} ${t.projectId} ${after.neonProjectId} `));
    const li = r.logs.findIndex((l) => l.startsWith(`LINKED ${t.id} ${t.projectId} ${after.neonProjectId} `));
    expect(sw).toBeGreaterThanOrEqual(0);
    expect(li).toBeGreaterThan(sw);
    const mail = r.emails[0].message;
    expect(mail).toMatch(/changes after \d{4}-\d\d-\d\dT[\d:.]+Z UTC need re-entering/);
    expect(mail).toContain(`lower neon-ops@ to Viewer on project ${after.neonProjectId}`);
    expect(mail).toContain('Deploy to Production');
    expect(mail).toContain(t.slug); // the private email may name the workspace
    expect(slugsIn(r.logs.join('\n'))).toEqual([]);
    const [run] = await w.cpSql`SELECT status, mode FROM disaster_runs WHERE run_id = ${r.args.runId}`;
    expect(run).toMatchObject({ status: 'pass', mode: 'workspace' });
  }, 120_000);

  describe('R2: every refusal and failure leaves the row unchanged and deletes what the task created', () => {
    it('200 without the override → original-exists (proof recorded, nothing created)', async () => {
      const t = take();
      const before = await tenantRow(w, t.id);
      const r = await press(w, { targets: [t.id] });
      expect(r.exitCode).toBe(1);
      await expectUnchanged(t, before);
      expect((await actions(w, t.id)).map((a) => `${a.kind}:${a.status}`)).toEqual(['proof:refused:original-exists']);
      expect(createdFor(t)).toEqual([]);
    });

    it('a recoverable original → refused:recoverable ("recover it in the Neon console")', async () => {
      const t = take();
      w.neon.markDeleted(t.projectId);
      const r = await press(w, { targets: [t.id] });
      expect(r.exitCode).toBe(1);
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:recoverable']);
      expect(r.emails[0].message).toContain('recover it in the Neon console');
    });

    it('unproven: the positive control sees an incomplete list → proof-failed', async () => {
      const t = take();
      makeGone(w, t);
      w.neon.unavailable = { ids: ['prj-slow'], calls: 1 };
      const r = await press(w, { targets: [t.id] });
      expect(r.exitCode).toBe(1);
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:proof-failed']);
    });

    it('unproven: a personal key without the org (an empty list) never proves anything', async () => {
      const t = take();
      makeGone(w, t);
      const wrongOrg = neonApi({ apiKey: w.neon.apiKey, orgId: 'org-not-mine', baseUrl: w.neon.url, sleep: async () => {}, operationPollMs: 1 });
      const r = await press(w, { targets: [t.id] }, { neon: wrongOrg });
      expect(r.exitCode).toBe(1);
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:proof-failed']);
    });

    it('proof (d): the project 404s but the stored URL still logs in → refused:reachable', async () => {
      const t = take();
      w.neon.projects.delete(t.projectId); // gone from Neon's API, but its host still reaches a live database
      const r = await press(w, { targets: [t.id] });
      expect(r.exitCode).toBe(1);
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:reachable']);
    });

    it('proof (d): 28P01, and a live `cadenzpoint-<slug>` project lists the endpoint (a stale project id) → refused:reachable', async () => {
      const t = take();
      makeGone(w, t);
      w.neon.addProject({ name: `cadenzpoint-${t.slug}`, host: t.host, mapTo: { host: w.proxy.host, port: w.proxy.port } });
      const r = await press(w, { targets: [t.id] });
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:reachable']);
      expect(r.exitCode).toBe(1);
    });

    it('D3: an integrity failure (a tampered newest backup) falls back to the older one in a fresh project; the failed project is deleted', async () => {
      const t = take();
      makeGone(w, t);
      const [newest, older] = keysOf(t);
      const obj = w.bucket.objects.get(newest)!;
      obj.bytes = Buffer.from(obj.bytes);
      obj.bytes[obj.bytes.length - 40] ^= 0xff; // the SHA-256 (and the GCM tag) no longer match
      const r = await press(w, { targets: [t.id] });
      expect(r.exitCode, r.logs.join('\n')).toBe(0);
      const acts = await actions(w, t.id);
      expect(acts.map((a) => `${a.kind}:${a.status}`)).toEqual(['proof:gone', 'rebuild:intended', 'rebuild:created', 'rebuild:deleted', 'rebuild:intended', 'rebuild:created', 'rebuild:linked']);
      expect(acts[1].projectName).toMatch(/-1$/);
      expect(acts[4].projectName).toMatch(/-2$/);
      const linked = acts.at(-1)!;
      expect(r.emails[0].message).toContain(older);
      expect(r.emails[0].message).toContain('1 newer backup(s) failed verification');
      expect(w.neon.projects.get(acts[2].newProjectId!)!.deleted).toBe(true);
      expect((await tenantRow(w, t.id)).neonProjectId).toBe(linked.newProjectId);
    }, 60_000);

    it('D3: an infrastructure failure retries the SAME backup once in a fresh project (then links); twice → retryable, nothing switched', async () => {
      const t = take();
      makeGone(w, t);
      const [newest] = keysOf(t);
      let fails = 1;
      w.bucket.failGet = (k) => k === newest && fails-- > 0;
      const r = await press(w, { targets: [t.id] });
      w.bucket.failGet = () => false;
      expect(r.exitCode, r.logs.join('\n')).toBe(0);
      expect(r.emails[0].message).toContain(newest);

      const u = take();
      makeGone(w, u);
      const before = await tenantRow(w, u.id);
      const [uNewest] = keysOf(u);
      w.bucket.failGet = (k) => k === uNewest;
      const r2 = await press(w, { targets: [u.id] });
      w.bucket.failGet = () => false;
      expect(r2.exitCode).toBe(1);
      expect(r2.outcome!.results[0].result).toBe('retryable');
      await expectUnchanged(u, before);
      expect(createdFor(u).every((p) => p.deleted)).toBe(true);
      expect(createdFor(u).length).toBe(2);
    }, 60_000);

    it('an unclassified restore failure → restore-failed: no fallback, the project deleted', async () => {
      const t = take();
      makeGone(w, t);
      const before = await tenantRow(w, t.id);
      const r = await press(w, { targets: [t.id] }, { pgRestoreBin: '/usr/bin/false' });
      expect(r.outcome!.results[0].result).toBe('restore-failed');
      await expectUnchanged(t, before);
      expect(createdFor(t).length).toBe(1);
      expect(createdFor(t)[0].deleted).toBe(true);
    });

    it('a Neon create refusal (4xx) → create, with Neon\'s status and code only (no body)', async () => {
      const t = take();
      makeGone(w, t);
      w.neon.script('POST /projects', [422]);
      const r = await press(w, { targets: [t.id] });
      expect(r.outcome!.results[0].result).toBe('create');
      expect(r.emails[0].message).toContain('HTTP 422 CODE_422');
      expect(r.emails[0].message + r.logs.join('\n')).not.toContain('said no');
      expect(slugsIn(r.logs.join('\n'))).toEqual([]); // R1: no slug on the failure paths either
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['gone', 'intended', 'failed']);
    });

    it('a lost create response: the project is found by name, adopted, cleaned up, and the same backup retried → linked', async () => {
      const t = take();
      makeGone(w, t);
      w.neon.script('POST /projects', ['lost']);
      const r = await press(w, { targets: [t.id] });
      expect(r.exitCode, r.logs.join('\n')).toBe(0);
      const acts = await actions(w, t.id);
      expect(acts.map((a) => a.status)).toEqual(['gone', 'intended', 'created', 'deleted', 'intended', 'created', 'linked']);
      expect(acts[2].detail).toBe('adopted after a failed create');
    }, 60_000);

    it('guards fail (the new project\'s endpoints can\'t be read) → nothing switched, project deleted; a failed delete → `failed` (the leftover finding\'s input)', async () => {
      const t = take();
      makeGone(w, t);
      const before = await tenantRow(w, t.id);
      w.neon.script('GET /projects/:id/endpoints', [503]);
      w.neon.script('DELETE /projects/:id', [500]);
      const r = await press(w, { targets: [t.id] });
      expect(r.outcome!.results[0].result).toBe('guard');
      await expectUnchanged(t, before);
      const acts = await actions(w, t.id);
      expect(acts.at(-1)).toMatchObject({ kind: 'rebuild', status: 'failed' });
      expect(acts.at(-1)!.detail).toContain('delete:');
      expect(createdFor(t)[0].deleted).toBe(false); // kept and reported
      expect(slugsIn(r.logs.join('\n'))).toEqual([]);
    });

    it('no backup at all → no-backup, nothing created', async () => {
      const t = take();
      makeGone(w, t);
      for (const k of [...w.bucket.objects.keys()]) if (k.startsWith(targetPrefix(w.cpId, 'tenant', t.id))) w.bucket.objects.delete(k);
      const r = await press(w, { targets: [t.id] });
      expect(r.outcome!.results[0].result).toBe('no-backup');
      expect(createdFor(t)).toEqual([]);
    });

    it('facts: a deletion date that has passed → its real proof is recorded (detail deletion-due), then refused deletion-due', async () => {
      const t = take();
      makeGone(w, t);
      await w.cpSql`UPDATE tenants SET deletion_scheduled_for = now() - interval '1 day' WHERE id = ${t.id}`;
      const r = await press(w, { targets: [t.id] });
      expect(r.outcome!.results[0].result).toBe('deletion-due');
      expect(await actions(w, t.id)).toEqual([expect.objectContaining({ kind: 'proof', status: 'gone', detail: 'deletion-due' })]);
    });
  });

  it('D3: a log-confirmed object (no `ok` row: a catch-up or late tenant) is a candidate; its counts come from the sidecar', async () => {
    const t = take();
    makeGone(w, t);
    await w.cpSql`DELETE FROM database_backups WHERE tenant_id = ${t.id}`;
    const r = await press(w, { targets: [t.id] });
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    // With no BACKUP line either, nothing qualifies.
    const u = take();
    makeGone(w, u);
    await w.cpSql`DELETE FROM database_backups WHERE tenant_id = ${u.id}`;
    const r2 = await press(w, { targets: [u.id] }, { logReader: fakeLogReader([]) });
    expect(r2.outcome!.results[0].result).toBe('no-backup');
  }, 60_000);

  it('R3: the row changes meanwhile → changed-meanwhile, nothing switched, the new project deleted', async () => {
    const t = take();
    makeGone(w, t);
    const base = api();
    const changing: NeonApi = {
      ...base,
      async listEndpoints(id) {
        if (id !== t.projectId && createdFor(t).some((p) => p.id === id)) await w.cpSql`UPDATE tenants SET db_url_encrypted = ${encrypt(`${t.url}x`)} WHERE id = ${t.id}`;
        return base.listEndpoints(id);
      },
    };
    const r = await press(w, { targets: [t.id] }, { neon: changing });
    expect(r.outcome!.results[0].result).toBe('changed-meanwhile');
    expect((await tenantRow(w, t.id)).neonProjectId).toBe(t.projectId);
    expect(createdFor(t)[0].deleted).toBe(true);
  });

  it('the gone path\'s re-check: the original is back before the switch → aborted, proof-failed recorded, project deleted', async () => {
    const t = take();
    makeGone(w, t);
    const base = api();
    const returning: NeonApi = {
      ...base,
      async listEndpoints(id) {
        if (createdFor(t).some((p) => p.id === id)) w.neon.addProject({ id: t.projectId, name: `cadenzpoint-${t.slug}`, host: fakeHost() });
        return base.listEndpoints(id);
      },
    };
    const r = await press(w, { targets: [t.id] }, { neon: returning });
    expect(r.outcome!.results[0].result).toBe('original-back');
    expect((await actions(w, t.id)).at(-1)).toMatchObject({ kind: 'proof', status: 'refused:proof-failed' });
    expect(createdFor(t)[0].deleted).toBe(true);
  });

  it('D8: older running runs are closed as abandoned by the next run; workspaces not reached before a stop are reported "not started"', async () => {
    await w.cpSql`INSERT INTO disaster_runs (run_id, mode, started_at, status) VALUES ('gh-old-1', 'workspace', now() - interval '7 hours', 'running')`;
    const t = take();
    const stop = new AbortController();
    stop.abort('stopped');
    const r = await press(w, { targets: [t.id, take().id] }, { stopSignal: stop.signal });
    const [old] = await w.cpSql`SELECT status, summary FROM disaster_runs WHERE run_id = 'gh-old-1'`;
    expect(old.status).toBe('fail');
    expect(old.summary).toMatchObject({ detail: 'abandoned' });
    expect(r.outcome!.results.map((x) => x.result)).toEqual(['not-started', 'not-started']);
    expect(r.emails[0].message).toContain('not started; press again');
  });

  it('R5b: mode workspace started by anything but gh-/cloudshell- (the schedule) is refused before any work', async () => {
    const t = take();
    makeGone(w, t);
    const r = await press(w, { targets: [t.id] }, { ecs: fakeEcs({ startedBy: 'chronos-schedule/cadenzpoint-backup-disaster-rehearse' }) });
    expect(r.exitCode).toBe(1);
    expect(r.logs.join('\n')).toContain('mode workspace runs only from the button');
    expect(await actions(w, t.id)).toEqual([]);
    const ok = await press(w, { targets: [t.id] }, { ecs: fakeEcs({ startedBy: 'cloudshell-20261117' }) });
    expect(ok.exitCode, ok.logs.join('\n')).toBe(0);
  }, 60_000);

  describe('R5: the override (original exists, unreachable for 4 hours)', () => {
    /** The original project stays (200) but its compute endpoint is gone: the stored host now answers 28P01. */
    const endpointGone = (t: WorldTenant) => {
      const p = w.neon.projects.get(t.projectId)!;
      p.endpoints = [{ id: 'ep-new', host: fakeHost() }];
      w.neon.hostMap[t.host] = { host: w.proxy.host, port: w.proxy.port };
      w.neon.hostMap[poolerOf(t.host)] = { host: w.proxy.host, port: w.proxy.port };
    };
    const later = (h: number) => () => new Date(Date.now() + h * HOUR);
    const insertBackupRow = (t: WorldTenant, o: { runId: string; hoursAgo: number; status: 'failed' | 'ok'; error?: string }) =>
      w.cpSql`INSERT INTO database_backups (tenant_id, target, run_id, status, target_deadline_ms, error, started_at, finished_at)
        VALUES (${t.id}, 'tenant', ${o.runId}, ${o.status}, 1800000, ${o.error ?? null}, now() - ${`${o.hoursAgo} hours`}::interval, now() - ${`${o.hoursAgo} hours`}::interval)`;
    const connectFail = summarizeError('connect', new Error("Couldn't connect to compute node")); // Neon's proxy wording

    it('endpoint-gone end to end: the first press records observed-unreachable and refuses; a press 4+ h later (fake clock) switches, re-check included; watch AND returned raised', async () => {
      const t = take();
      endpointGone(t);
      const first = await press(w, { targets: [t.id], override: 'unreachable-4h' });
      expect(first.exitCode).toBe(1);
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['observed-unreachable']);
      expect(first.emails[0].message).toContain('press again with the override after');
      const second = await press(w, { targets: [t.id], override: 'unreachable-4h' }, { now: later(5) });
      expect(second.exitCode, second.logs.join('\n')).toBe(0);
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['observed-unreachable', 'unreachable-4h', 'intended', 'created', 'linked']);
      expect(second.emails[0].message).toContain('override evidence: observed unreachable at');
      expect((await w.cpSql`SELECT 1 FROM ops_alerts WHERE kind = 'rebuild-original-returned' AND dedup_key = ${t.projectId} AND resolved_at IS NULL`).length).toBe(1);
      expect((await w.cpSql`SELECT 1 FROM ops_alerts WHERE kind = 'rebuild-original-watch' AND dedup_key = ${t.projectId}`).length).toBe(1);
      expect(w.neon.projects.get(t.projectId)!.deleted).toBe(false); // the original is kept
    }, 60_000);

    it('3b evidence: connect failures (Neon\'s proxy wording → connection-refused) from two runs ≥ 4 h apart, no ok since → the FIRST press proceeds', async () => {
      const t = take();
      endpointGone(t);
      await w.cpSql`UPDATE database_backups SET finished_at = now() - interval '20 hours', started_at = now() - interval '20 hours' WHERE tenant_id = ${t.id} AND status = 'ok'`;
      await insertBackupRow(t, { runId: 'test-run-a', hoursAgo: 14, status: 'failed', error: connectFail });
      await insertBackupRow(t, { runId: 'test-run-b', hoursAgo: 2, status: 'failed', error: connectFail });
      const r = await press(w, { targets: [t.id], override: 'unreachable-4h' });
      expect(r.exitCode, r.logs.join('\n')).toBe(0);
      expect(r.emails[0].message).toContain('backups failed to connect at');
    }, 60_000);

    it('3b rows that are not evidence: stage upload/row; one connect failure; two from one run minutes apart', async () => {
      for (const rows of [
        [{ runId: 'test-u1', hoursAgo: 14, error: 'upload label=s3-error' }, { runId: 'test-u2', hoursAgo: 2, error: 'row label=other' }],
        [{ runId: 'test-s1', hoursAgo: 10, error: connectFail }],
        [{ runId: 'test-m1', hoursAgo: 10, error: connectFail }, { runId: 'test-m1', hoursAgo: 9.9, error: connectFail }],
      ]) {
        const t = take();
        endpointGone(t);
        for (const r of rows) await insertBackupRow(t, { ...r, status: 'failed' });
        const p = await press(w, { targets: [t.id], override: 'unreachable-4h' });
        expect(p.exitCode).toBe(1);
        expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['observed-unreachable']);
      }
    }, 60_000);

    it('evidence is ignored when older than a rebuild (`linked`), when an `ok` backup came since, or after a refused:reachable press', async () => {
      const cases: Array<(t: WorldTenant) => Promise<unknown>> = [
        (t) => w.cpSql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, new_project_id, at) VALUES ('gh-r-1', ${t.id}, 'rebuild', 'linked', ${t.projectId}, now() + interval '1 hour')`,
        (t) => insertBackupRow(t, { runId: 'test-ok', hoursAgo: -1, status: 'ok' }),
        (t) => w.cpSql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, old_project_id, at) VALUES ('gh-r-2', ${t.id}, 'proof', 'refused:reachable', ${t.projectId}, now() + interval '1 hour')`,
      ];
      for (const mutate of cases) {
        const t = take();
        endpointGone(t);
        expect((await press(w, { targets: [t.id], override: 'unreachable-4h' })).exitCode).toBe(1); // observed
        await mutate(t);
        const p = await press(w, { targets: [t.id], override: 'unreachable-4h' }, { now: later(5) });
        expect(p.exitCode).toBe(1);
        expect((await actions(w, t.id)).filter((a) => a.kind === 'proof').map((a) => a.status).at(-1)).toBe('observed-unreachable');
      }
    }, 90_000);

    it('a 28P01 with the endpoint still listed → refused:credentials (data intact; skippable)', async () => {
      const t = take();
      w.neon.hostMap[t.host] = { host: w.proxy.host, port: w.proxy.port };
      w.neon.hostMap[poolerOf(t.host)] = { host: w.proxy.host, port: w.proxy.port };
      const r = await press(w, { targets: [t.id], override: 'unreachable-4h' });
      expect(r.exitCode).toBe(1);
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:credentials']);
    });

    it('the override\'s login succeeds → refused:reachable; a missing database (3D000) → refused:database-missing', async () => {
      const t = take();
      await press(w, { targets: [t.id], override: 'unreachable-4h' });
      expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['refused:reachable']);
      const u = take();
      const missing = new URL(u.url);
      missing.pathname = '/bkt_dr_nosuchdb';
      await w.cpSql`UPDATE tenants SET db_url_encrypted = ${encrypt(missing.toString())} WHERE id = ${u.id}`;
      await press(w, { targets: [u.id], override: 'unreachable-4h' });
      expect((await actions(w, u.id)).map((a) => a.status)).toEqual(['refused:database-missing']);
    });

    it('D8: the override re-check before the switch: credentials → refused:credentials; answers → refused:reachable; 3D000 → refused:database-missing; a 404 → proof-failed', async () => {
      const backOnLocal = (t: WorldTenant) => {
        w.neon.projects.get(t.projectId)!.endpoints = [{ id: 'ep-x', host: t.host }];
        const local = new URL(process.env.CONTROL_PLANE_DATABASE_URL!);
        w.neon.hostMap[t.host] = { host: local.hostname, port: Number(local.port || 5432) };
        w.neon.hostMap[poolerOf(t.host)] = w.neon.hostMap[t.host];
      };
      const outcomes: Array<[string, (t: WorldTenant) => void, boolean?]> = [
        ['refused:credentials', (t) => { w.neon.projects.get(t.projectId)!.endpoints = [{ id: 'ep-x', host: t.host }]; }],
        ['refused:proof-failed', (t) => { w.neon.purge(t.projectId); }],
        ['refused:reachable', backOnLocal],
        ['refused:database-missing', backOnLocal, true],
      ];
      for (const [status, flip, missingDb] of outcomes) {
        const t = take();
        if (missingDb) {
          const u = new URL(t.url);
          u.pathname = '/bkt_dr_nosuchdb';
          await w.cpSql`UPDATE tenants SET db_url_encrypted = ${encrypt(u.toString())} WHERE id = ${t.id}`;
        }
        endpointGone(t);
        await press(w, { targets: [t.id], override: 'unreachable-4h' });
        const base = api();
        const flipping: NeonApi = { ...base, async listEndpoints(id) { if (createdFor(t).some((p) => p.id === id)) flip(t); return base.listEndpoints(id); } };
        const r = await press(w, { targets: [t.id], override: 'unreachable-4h' }, { now: later(5), neon: flipping });
        expect(r.outcome!.results[0].result, status).toBe('reachable-now');
        expect((await actions(w, t.id)).at(-1)!.status).toBe(status);
        expect(createdFor(t).every((p) => p.deleted)).toBe(true);
      }
    }, 90_000);
  });
});

describe.skipIf(!CAN_RUN)('R4: all-lost', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(5, 'test-dr-all'); }, 180_000);
  afterAll(async () => { await w?.close(); });

  it('picks exactly the gone tenants (never via the override); a tenant whose project 404s but whose URL still connects is not rebuilt', async () => {
    const [g1, g2, reachable, live1, live2] = w.tenants;
    makeGone(w, g1);
    makeGone(w, g2);
    w.neon.projects.delete(reachable.projectId); // 404, but its host still reaches a live database
    const r = await press(w, { targets: 'all-lost' });
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    const res = Object.fromEntries(r.outcome!.results.map((x) => [x.tenantId, x.result]));
    expect(res).toEqual({ [g1.id]: 'linked', [g2.id]: 'linked', [reachable.id]: 'not-lost' });
    for (const t of [live1, live2]) expect(await actions(w, t.id)).toEqual([]);
    expect(r.logs).toContain('all-lost: 3 workspace(s) whose project is missing, of 5 live');
  }, 120_000);
});
