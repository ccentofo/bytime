import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';

// Fix round 1, FR10 (C19, C20): the reconcile's inputs from mode control-plane are captured (the real reconcile still runs).
const reconcileInputs: Array<{ cpDirectHost: string; windowStart: Date; windowEnd: Date; controlPlaneProjectIds: string[] }> = [];
vi.mock('../../../scripts/backup/disaster-reconcile', async (orig) => {
  const real = await orig<typeof import('../../../scripts/backup/disaster-reconcile')>();
  return { ...real, runReconcile: async (input: Parameters<typeof real.runReconcile>[0]) => { reconcileInputs.push({ cpDirectHost: input.cpDirectHost, windowStart: input.windowStart, windowEnd: input.windowEnd, controlPlaneProjectIds: input.controlPlaneProjectIds }); return real.runReconcile(input); } };
});
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  CAN_RUN, PG_RESTORE, RESTORE_TEST_URL, backUpControlPlaneAgain, controlPlaneNeonUrl, createWorld, deps as worldDeps, fakeLogReader, makeGone, press, setControlPlane,
  type RunCapture, type World,
} from './disaster-harness';
import { runDisaster, type DisasterDeps } from '../../../scripts/backup/disaster';
import { pgConnector, type Connector } from '../../../scripts/backup/lib/classify-endpoint';
import { controlPlaneId, targetPrefix } from '../../../scripts/backup/lib/keys';
import { connectUrl } from '../../../scripts/backup/lib/host-map';
import { clientUrl } from '../../../scripts/backup/lib/pg-url';
import { controlPlaneRebuildName } from '../../../scripts/backup/lib/project-names';
import { directHost, neonApi, type NeonApi } from '../../../scripts/backup/lib/neon-api';
import { encryptionContext, encryptBuffer, decryptBuffer } from '../../../scripts/backup/lib/crypto';
import { baseKey } from '../../../scripts/backup/lib/keys';
import { createHash } from 'node:crypto';
import { createScratchDb, dropScratchDb } from './backup-helpers';
import { runRestoreTest } from '../../../scripts/backup/restore-test';
import { testKeyring } from '../helpers/backup-fakes';

/**
 * feature-plan-control-plane-disaster.md §11 T4, T5, T7–T11 and the stop row of §7.1: mode `control-plane` end to end
 * against a scratch control plane backed up for real (pg_dump 16 into the fake bucket), the fake Neon API (its new
 * projects are real local `bkt_dr_*` databases), real pg_restore 16 and the local 28P01 proxy stand-in. No fixed sleeps:
 * stops are triggered by the `DISASTER-PROJECT` log line.
 */

const CP_PROJECT_RE = /^cadenzpoint-control-r\d{14}-\d+$/;

describe.skipIf(!CAN_RUN)('disaster control-plane', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld(3, 'test-cpd');
    await backUpControlPlaneAgain(w);
  }, 240_000);
  afterAll(async () => { await w?.close(); });
  /** Projects that existed before this test: everCreated() counts only this test's. */
  let before = new Set<string>();
  beforeEach(() => { before = new Set(w.neon.projects.keys()); });
  afterEach(() => {
    // Every rebuilt or leftover control-plane project is removed between tests, and the old control plane is gone again.
    for (const p of w.neon.projects.values()) if (CP_PROJECT_RE.test(p.name) && !p.deleted) w.neon.markDeleted(p.id);
    w.neon.unavailable = { ids: [], calls: 0 };
    setControlPlane(w, 'gone');
  });

  const oldUrl = () => controlPlaneNeonUrl(w);
  const cpDeps = (over: Partial<DisasterDeps> = {}): Partial<DisasterDeps> => ({ controlPlaneUrl: oldUrl(), restoreTestUrl: RESTORE_TEST_URL, ...over });
  const pressCp = (over: Partial<DisasterDeps> = {}) => press(w, { mode: 'control-plane', targets: 'control-plane' }, cpDeps(over));
  const live = () => [...w.neon.projects.values()].filter((p) => CP_PROJECT_RE.test(p.name) && !p.deleted);
  const everCreated = () => [...w.neon.projects.values()].filter((p) => CP_PROJECT_RE.test(p.name) && !before.has(p.id));
  const newCp = (projectId: string) => {
    const p = w.neon.projects.get(projectId)!;
    return postgres(clientUrl(connectUrl(p.connectionUri!, w.neon.hostMap)), { max: 1, onnotice: () => {} });
  };
  const cpObjects = () => [...w.bucket.objects.keys()].filter((k) => k.startsWith(targetPrefix(w.cpId, 'control-plane', 'control-plane')) && k.endsWith('.dump.enc'))
    .sort((a, b) => w.bucket.objects.get(b)!.lastModified.getTime() - w.bucket.objects.get(a)!.lastModified.getTime());

  describe('T7: the gone-proof, one leg at a time', () => {
    it('network unproven (the restore-test database does not connect) → refused, nothing created; the refusal is emailed', async () => {
      const r = await pressCp({ restoreTestUrl: 'postgres://u:p@127.0.0.1:1/never' });
      expect(r.exitCode).toBe(1);
      expect(r.outcome?.results[0].result).toBe('network-unproven');
      expect(r.emails).toHaveLength(1);
      expect(r.emails[0].subject).toContain('FAILED');
      expect(everCreated()).toHaveLength(0);
    });

    it('the old project answers 200 → original-exists ("wait for Neon")', async () => {
      setControlPlane(w, 'live');
      const r = await pressCp();
      expect(r.outcome?.results[0].result).toBe('original-exists');
      expect(r.emails[0].message).toContain('wait for Neon');
      expect(everCreated()).toHaveLength(0);
    });

    it('the old project is recoverable → recoverable ("recover it in the Neon console")', async () => {
      setControlPlane(w, 'recoverable');
      const r = await pressCp();
      expect(r.outcome?.results[0].result).toBe('recoverable');
      expect(r.emails[0].message).toContain('recover it in the Neon console');
    });

    it('the positive control fails (the list lacks the restore-test project; or the list is incomplete) → proof-failed', async () => {
      expect((await pressCp({ restoreTestProjectId: 'prj-not-in-the-org' })).outcome?.results[0].result).toBe('proof-failed');
      w.neon.unavailable = { ids: ['prj-x'], calls: 1 };
      expect((await pressCp()).outcome?.results[0].result).toBe('proof-failed');
      // The restore-test project answers 200 by id but isn't in the key's organisation list (a wrong org: GET by id
      // ignores the org, so a 200 alone proves nothing).
      const base = worldDeps(w, { logs: [], emails: [] }).neon;
      const neon: NeonApi = { ...base, async listProjects(q) { const l = await base.listProjects(q); return { ...l, projects: l.projects.filter((p) => p.id !== w.restoreTestProjectId) }; } };
      expect((await pressCp({ neon })).outcome?.results[0].result).toBe('proof-failed');
      expect(everCreated()).toHaveLength(0);
    });

    it('the address logs in (the URL in SSM answers) → reachable, with the SSM hint', async () => {
      const r = await pressCp({ controlPlaneUrl: w.cp.url });
      expect(r.outcome?.results[0].result).toBe('reachable');
      expect(r.emails[0].message).toContain("check that SSM's URL and project id match Vercel's");
    });

    it('a live control-plane-named project serves the address → served', async () => {
      const moved = w.neon.addProject({ name: 'cadenzpoint-control-moved', host: `${w.controlPlaneHost}` });
      w.neon.hostMap[w.controlPlaneHost] = { host: w.proxy.host, port: w.proxy.port }; // its login still says 28P01
      w.neon.hostMap[w.controlPlaneHost.replace(/^([^.]+)/, '$1-pooler')] = { host: w.proxy.host, port: w.proxy.port };
      try {
        const r = await pressCp();
        expect(r.outcome?.results[0].result).toBe('served');
        expect(r.emails[0].message).toContain('/cadenzpoint/backup/control-plane-project-id');
      } finally {
        w.neon.purge(moved.id);
      }
    });
  });

  describe('T8: an earlier rebuild still present', () => {
    it('a live project named by the §6.11 builder, at any age → rebuild-exists with the don\'t-delete wording; nothing created', async () => {
      const old = w.neon.addProject({ name: controlPlaneRebuildName(new Date('2025-01-01T00:00:00Z'), 1), createdAt: new Date('2025-01-01T00:00:00Z') });
      try {
        const r = await pressCp();
        expect(r.outcome?.results[0].result).toBe('rebuild-exists');
        expect(r.emails[0].message).toContain(`a rebuilt control plane exists: ${old.id}, created 2025-01-01T00:00:00.000Z`);
        expect(r.emails[0].message).toContain("it's your live control plane: don't delete it");
        expect(everCreated().filter((p) => p.id !== old.id)).toHaveLength(0);
      } finally {
        w.neon.markDeleted(old.id);
      }
    });
    it('cadenzpoint-control-risk is not a rebuild (the press goes on to rebuild)', async () => {
      const risk = w.neon.addProject({ name: 'cadenzpoint-control-risk' });
      try {
        const r = await pressCp();
        expect(r.outcome?.results[0].result).not.toBe('rebuild-exists');
        expect(r.outcome?.results[0].result).toMatch(/^rebuilt/);
      } finally {
        w.neon.purge(risk.id);
      }
    }, 120_000);
  });

  describe('T9: candidates and the build', () => {
    it('no BACKUP line → no-backup (skipped, counted); nothing created', async () => {
      const r = await pressCp({ logReader: fakeLogReader(w.lines.filter((l) => l.target !== 'control-plane')) });
      expect(r.outcome?.results[0].result).toBe('no-backup');
      expect(r.emails[0].message).toContain(`${cpObjects().length} object(s) had no BACKUP line`);
      expect(everCreated()).toHaveLength(0);
    });

    it('the newest dump has no line → the older one is used (skipped counted in the email)', async () => {
      const newest = cpObjects()[0];
      const r = await pressCp({ logReader: fakeLogReader(w.lines.filter((l) => l.key !== newest)) });
      expect(r.outcome?.results[0]).toMatchObject({ result: expect.stringMatching(/^rebuilt/), backupKey: cpObjects()[1] });
      expect(r.emails[0].message).toContain('1 newer backup(s) were skipped');
    }, 120_000);

    it('integrity: a corrupt newest dump → its project deleted and verified, then the older backup', async () => {
      const newest = cpObjects()[0];
      const obj = w.bucket.objects.get(newest)!;
      const saved = Buffer.from(obj.bytes);
      obj.bytes = Buffer.concat([saved.subarray(0, saved.length - 1), Buffer.from([saved[saved.length - 1] ^ 0xff])]);
      try {
        const r = await pressCp();
        expect(r.outcome?.results[0]).toMatchObject({ result: expect.stringMatching(/^rebuilt/), backupKey: cpObjects()[1] });
        const created = everCreated();
        expect(created).toHaveLength(2);
        expect(created.filter((p) => p.deleted)).toHaveLength(1); // the failed try, deleted (and the 404 verified)
      } finally {
        obj.bytes = saved;
      }
    }, 120_000);

    it('infrastructure: a 503 create → the same backup once more, then retryable; nothing kept', async () => {
      w.neon.script('POST /projects', [503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503]);
      try {
        const r = await pressCp({ neon: noBackoff() });
        expect(r.outcome?.results[0].result).toBe('retryable');
        expect(r.emails[0].message).toContain('Nothing was kept');
      } finally {
        w.neon.script('POST /projects', []);
      }
    });

    it('a lost create response → the project is adopted, deleted and verified; then retried', async () => {
      w.neon.script('POST /projects', ['lost']);
      const r = await pressCp();
      expect(r.outcome?.results[0].result).toMatch(/^rebuilt/);
      const created = everCreated();
      expect(created).toHaveLength(2);
      expect(created.filter((p) => p.deleted)).toHaveLength(1);
    }, 120_000);

    it("another environment's dump (encrypted for `staging`) fails the context check and is skipped for the older one", async () => {
      const newest = cpObjects()[0];
      const obj = w.bucket.objects.get(newest)!;
      const saved = Buffer.from(obj.bytes);
      // Re-encrypt the same plaintext under staging's context; the BACKUP line carries the new SHA-256, so only the context differs.
      const plain = await decryptBuffer(testKeyring(), saved, encryptionContext({ cp: w.cpId, kind: 'dump', target: 'control-plane', id: 'control-plane', key: baseKey(newest) }));
      const staged = (await encryptBuffer(testKeyring(), encryptionContext({ cp: 'staging', kind: 'dump', target: 'control-plane', id: 'control-plane', key: baseKey(newest) }), plain)).ciphertext;
      obj.bytes = staged;
      const sha = createHash('sha256').update(staged).digest('hex');
      const lines = w.lines.map((l) => (l.key === newest ? { ...l, sha256: sha } : l));
      try {
        const r = await pressCp({ logReader: fakeLogReader(lines) });
        expect(r.outcome?.results[0]).toMatchObject({ result: expect.stringMatching(/^rebuilt/), backupKey: cpObjects()[1] });
        expect(r.logs.join('\n')).toMatch(/failed verification \(context/);
      } finally {
        obj.bytes = saved;
      }
    }, 120_000);
  });

  describe('T10: the re-check', () => {
    it('the original is back after the build → the new project deleted, original-back, nothing recorded', async () => {
      const base = worldDeps(w, { logs: [], emails: [] }).neon;
      const neon: NeonApi = { ...base, async createProject(o, s) { const c = await base.createProject(o, s); setControlPlane(w, 'live'); return c; } };
      const r = await pressCp({ neon });
      expect(r.outcome?.results[0].result).toBe('original-back');
      expect(r.emails[0].message).toContain('keep using the original');
      const created = everCreated();
      expect(created).toHaveLength(1);
      expect(created[0].deleted).toBe(true);
    }, 120_000);
  });

  describe('T11: recording, the reconcile hand-off and the old URL', () => {
    it('the run row and the watch are in the NEW control plane in one transaction; no disaster_actions row; the old URL is only probed by (d)', async () => {
      const probes: string[] = [];
      const real = pgConnector({ hostMap: w.neon.hostMap });
      const connector: Connector = async (url) => { probes.push(url); return real(url); };
      let lockCalls = 0;
      const r = await pressCp({ connector, lockConnect: (() => { lockCalls++; throw new Error('no lock in mode control-plane'); }) as never });
      expect(r.outcome?.results[0].result).toMatch(/^rebuilt/);
      const [p] = live();
      expect(p.name).toMatch(CP_PROJECT_RE);
      const sql = newCp(p.id);
      try {
        const runs = await sql<Array<{ mode: string; status: string; summary: Record<string, unknown>; runId: string }>>`SELECT mode, status, summary, run_id AS "runId" FROM disaster_runs WHERE mode = 'control-plane'`;
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ runId: r.args.runId, status: expect.stringMatching(/^(pass|fail)$/) });
        expect(runs[0].summary).toMatchObject({ target: 'control-plane', previousProjectId: w.controlPlaneProjectId, newProjectId: p.id, newProjectName: p.name, backupKey: cpObjects()[0] });
        expect(typeof runs[0].summary.backupStartedAt).toBe('string');
        expect(typeof runs[0].summary.cpRunStartedAt).toBe('string');
        expect(runs[0].summary.reconcile).toBeDefined(); // merged, never replaced (§6.3 step 10)
        const watch = await sql<Array<{ detail: Record<string, unknown>; tenantId: string | null }>>`SELECT detail, tenant_id AS "tenantId" FROM ops_alerts WHERE kind = 'rebuild-original-watch' AND dedup_key = ${w.controlPlaneProjectId} AND resolved_at IS NULL`;
        expect(watch).toHaveLength(1);
        expect(watch[0].detail).toMatchObject({ kind: 'control-plane', oldProjectId: w.controlPlaneProjectId, newProjectId: p.id });
        expect(watch[0].tenantId).toBeNull();
        expect((await sql`SELECT 1 FROM disaster_actions WHERE run_id = ${r.args.runId}`)).toHaveLength(0);
      } finally {
        await sql.end({ timeout: 5 });
      }
      expect(probes.filter((u) => u === oldUrl())).toHaveLength(1); // leg (d) only
      expect(lockCalls).toBe(0);
      // The old scratch control plane got nothing.
      expect((await w.cpSql`SELECT 1 FROM disaster_runs WHERE run_id = ${r.args.runId}`)).toHaveLength(0);
      expect(r.logs.some((l) => l.startsWith(`DISASTER-PROJECT ${p.id} ${p.name}`))).toBe(true);
      expect(r.emails[0].message).toContain(`new Neon project ${p.id} (${p.name})`);
      expect(r.emails[0].message).toContain('keep the old one and delete the new project');
    }, 120_000);

    it('a recording failure → the project deleted (verified), retryable, nothing kept', async () => {
      const r = await pressCp({ hooks: { beforeCommit: async () => { throw new Error('boom'); } } });
      expect(r.outcome?.results[0].result).toBe('retryable');
      const created = everCreated();
      expect(created).toHaveLength(1);
      expect(created[0].deleted).toBe(true);
    }, 120_000);

    it('a stop before recording (SIGTERM at DISASTER-PROJECT) → the project deleted, not-finished', async () => {
      const stop = new AbortController();
      const cap: RunCapture = { logs: [], emails: [] };
      const d = worldDeps(w, cap, { ...cpDeps(), stopSignal: stop.signal, log: (l) => { cap.logs.push(l); if (l.startsWith('DISASTER-PROJECT ')) stop.abort(); } });
      const r = await runDisaster({ mode: 'control-plane', targets: 'control-plane', override: 'none', runId: `gh-${randomUUID().slice(0, 6)}-1` }, d);
      expect(r.exitCode).toBe(1);
      expect(r.outcome?.results[0].result).toBe('not-finished');
      expect(live()).toHaveLength(0);
      expect(everCreated().every((p) => p.deleted)).toBe(true);
    }, 120_000);

    it('logs carry ids only: no URL, host, slug or password', async () => {
      const r = await pressCp();
      const text = r.logs.join('\n');
      for (const bad of ['postgres://', 'postgresql://', w.controlPlaneHost, 'neon.tech', ...w.tenants.map((t) => t.slug)]) expect(text).not.toContain(bad);
    }, 120_000);
  });

  describe('fix round 1, FR10: mode control-plane', () => {
    it('C07: leg (d) unproven (an unclassifiable connection result) → proof-failed, nothing created', async () => {
      const real = pgConnector({ hostMap: w.neon.hostMap });
      const connector: Connector = async (url) => (url === oldUrl() ? { cls: 'unknown', code: null } : real(url));
      const r = await pressCp({ connector });
      expect(r.outcome?.results[0].result).toBe('proof-failed');
      expect(everCreated()).toHaveLength(0);
    });

    it('C14: the old project turns recoverable after the build → original-back (the re-check reads the recoverable list), nothing recorded', async () => {
      const base = worldDeps(w, { logs: [], emails: [] }).neon;
      const neon: NeonApi = { ...base, async createProject(o, sig) { const c = await base.createProject(o, sig); setControlPlane(w, 'recoverable'); return c; } };
      const r = await pressCp({ neon });
      expect(r.outcome?.results[0].result).toBe('original-back');
      expect(everCreated().every((p) => p.deleted)).toBe(true);
    }, 120_000);

    it('C17 (§7.1): the reconcile throws → fail (exit 1), the project kept, the run row `fail`, the email says to press reconcile', async () => {
      const r = await pressCp({ disasterLogReader: { async rebuildLines() { throw new Error('logs down'); } } });
      expect(r.exitCode).toBe(1);
      expect(r.outcome?.results[0].result).toBe('rebuilt-reconcile-failed');
      const [p] = live();
      expect(p).toBeDefined();
      expect(r.emails[0].subject).toContain('FAILED');
      expect(r.emails[0].message).toContain('press mode reconcile');
      const sql = newCp(p.id);
      try {
        const [row] = await sql<Array<{ status: string }>>`SELECT status FROM disaster_runs WHERE run_id = ${r.args.runId}`;
        expect(row.status).toBe('fail');
      } finally { await sql.end({ timeout: 5 }); }
    }, 120_000);

    it('C19, C20: the reconcile runs with the NEW control plane\'s direct host and the window backupStartedAt → cpRunStartedAt', async () => {
      reconcileInputs.length = 0;
      const r = await pressCp();
      const [p] = live();
      expect(reconcileInputs).toHaveLength(1);
      const got = reconcileInputs[0];
      expect(got.cpDirectHost).toBe(directHost(new URL(w.neon.projects.get(p.id)!.connectionUri!).hostname));
      expect(got.cpDirectHost).not.toBe(directHost(w.controlPlaneHost));
      const sql = newCp(p.id);
      try {
        const [row] = await sql<Array<{ summary: { backupStartedAt: string; cpRunStartedAt: string } }>>`SELECT summary FROM disaster_runs WHERE run_id = ${r.args.runId}`;
        expect(got.windowStart.toISOString()).toBe(row.summary.backupStartedAt);
        expect(got.windowEnd.toISOString()).toBe(row.summary.cpRunStartedAt);
        expect(got.windowStart.getTime()).toBeLessThan(got.windowEnd.getTime());
      } finally { await sql.end({ timeout: 5 }); }
      expect(got.controlPlaneProjectIds).toEqual([w.controlPlaneProjectId, p.id]);
    }, 120_000);

    it('C11: at most 3 candidates: with the 3 newest dumps corrupt, an older good one is never tried → no-backup', async () => {
      await backUpControlPlaneAgain(w); // 4+ control-plane dumps
      const objs = cpObjects();
      expect(objs.length).toBeGreaterThanOrEqual(4);
      const saved = objs.slice(0, 3).map((k) => [k, Buffer.from(w.bucket.objects.get(k)!.bytes)] as const);
      for (const [k, b] of saved) w.bucket.objects.get(k)!.bytes = Buffer.concat([b.subarray(0, b.length - 1), Buffer.from([b[b.length - 1] ^ 0xff])]);
      try {
        const r = await pressCp();
        expect(r.outcome?.results[0].result).toBe('no-backup');
        expect(everCreated()).toHaveLength(3);
        expect(everCreated().every((p) => p.deleted)).toBe(true);
      } finally {
        for (const [k, b] of saved) w.bucket.objects.get(k)!.bytes = b;
      }
    }, 180_000);
  });

  describe('T4, T5: backups stay findable after a rebuild', () => {
    it('T4: after the rebuild, a workspace rebuild against the NEW control plane finds the pre-rebuild tenant backup', async () => {
      const r = await pressCp();
      const [p] = live();
      expect(r.outcome?.results[0].result).toMatch(/^rebuilt/);
      const t = w.tenants[0];
      makeGone(w, t);
      // The workspace task connects to the new control plane (the host map points its Neon host at the local server).
      const ws = await press(w, { targets: [t.id] }, { controlPlaneUrl: connectUrl(w.neon.projects.get(p.id)!.connectionUri!, w.neon.hostMap), controlPlaneProjectId: p.id });
      expect(ws.outcome?.results[0].result).toBe('linked');
    }, 180_000);

    it('T5: the restore test against the NEW control plane finds the control-plane backup', async () => {
      await pressCp();
      const [p] = live();
      const lines: string[] = [];
      const rtDb = await createScratchDb('dr');
      try {
      const rt = await runRestoreTest({
        controlPlaneUrl: connectUrl(w.neon.projects.get(p.id)!.connectionUri!, w.neon.hostMap), cpId: w.cpId, restoreTestUrl: rtDb.url,
        reader: w.bucket, store: w.bucket, keyring: testKeyring(), pgRestoreBin: PG_RESTORE!, runId: `test-${randomUUID().slice(0, 8)}`,
        log: (l) => lines.push(l), hostGuardOverride: true, selectTargets: () => [], minObjectAgeMs: 0,
      });
      expect(lines.join('\n')).not.toContain('FAIL:list');
      expect(rt.results.find((x) => x.target === 'control-plane')?.result).toBe('PASS');
      } finally {
        await dropScratchDb(rtDb.name);
      }
    }, 180_000);
  });

  const noBackoff = (): NeonApi => {
    return neonApi({ apiKey: w.neon.apiKey, orgId: w.neon.orgId, baseUrl: w.neon.url, sleep: async () => {}, retries: 0, operationPollMs: 1 });
  };
});

describe.skipIf(!CAN_RUN)('T4 variant: with BACKUP_CONTROL_PLANE_ID unset (the host hash), the rebuilt control plane loses every backup', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld(1, 'test-cpdh', { cpId: (u) => controlPlaneId(u, {}) });
    await backUpControlPlaneAgain(w);
  }, 240_000);
  afterAll(async () => { await w?.close(); });

  it('the workspace rebuild against the rebuilt control plane, keyed by its host hash, finds no backup', async () => {
    setControlPlane(w, 'gone');
    const r = await press(w, { mode: 'control-plane', targets: 'control-plane' }, { controlPlaneUrl: controlPlaneNeonUrl(w), restoreTestUrl: RESTORE_TEST_URL });
    expect(r.outcome?.results[0].result).toMatch(/^rebuilt/);
    const p = [...w.neon.projects.values()].find((x) => CP_PROJECT_RE.test(x.name) && !x.deleted)!;
    const t = w.tenants[0];
    makeGone(w, t);
    const pooled = w.neon.projects.get(p.id)!.pooledUri!;
    const ws = await press(w, { targets: [t.id] }, { controlPlaneUrl: connectUrl(w.neon.projects.get(p.id)!.connectionUri!, w.neon.hostMap), controlPlaneProjectId: p.id, cpId: controlPlaneId(pooled, {}) });
    expect(ws.outcome?.results[0].result).toBe('no-backup');
  }, 180_000);
});
