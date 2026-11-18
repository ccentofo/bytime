import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  CAN_RUN, RESTORE_TEST_URL, backUpControlPlaneAgain, createWorld, deps as worldDeps, makeGone, press, type RunCapture, type World,
} from './disaster-harness';
import { runDisaster } from '../../../scripts/backup/disaster';
import { pgConnector, type Connector } from '../../../scripts/backup/lib/classify-endpoint';
import { connectUrl } from '../../../scripts/backup/lib/host-map';
import { clientUrl } from '../../../scripts/backup/lib/pg-url';
import { targetPrefix } from '../../../scripts/backup/lib/keys';
import type { NeonApi } from '../../../scripts/backup/lib/neon-api';
import type { DisasterLogReader } from '../../../scripts/backup/lib/log-reader';

/**
 * feature-plan-control-plane-disaster.md §11 T21 (the control-plane rehearsal) and T20 (the run row's `target` and its
 * merged summary): against a live scratch control plane backed up for real, the fake Neon API (copies are real local
 * databases), real pg_restore 16 and the 28P01 proxy stand-in. No fixed sleeps.
 */

const REHEARSAL_RE = /^cadenzpoint-rehearse-cp-\d{14}-\d+$/;
const noLines: DisasterLogReader = { async rebuildLines() { return []; } };

describe.skipIf(!CAN_RUN)('the control-plane rehearsal', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld(3, 'test-rcp');
    makeGone(w, w.tenants[0]); // so the copy's dry-run reconcile has a decisive class to record (lost → `gone`)
    await backUpControlPlaneAgain(w);
  }, 240_000);
  afterAll(async () => { await w?.close(); });
  let before = new Set<string>();
  beforeEach(() => { before = new Set(w.neon.projects.keys()); });

  const copies = () => [...w.neon.projects.values()].filter((p) => REHEARSAL_RE.test(p.name) && !before.has(p.id));
  const rehearse = (over: Parameters<typeof press>[2] = {}) => press(w, { mode: 'rehearse', targets: 'control-plane' }, { restoreTestUrl: RESTORE_TEST_URL, disasterLogReader: noLines, ...over });
  const rows = (runId: string) => w.cpSql<Array<{ kind: string; status: string; tenantId: string | null; projectName: string | null; newProjectId: string | null }>>`
    SELECT kind, status, tenant_id AS "tenantId", project_name AS "projectName", new_project_id AS "newProjectId" FROM disaster_actions WHERE run_id = ${runId} ORDER BY at, id`;
  const runRow = async (runId: string) => (await w.cpSql<Array<{ mode: string; status: string; summary: Record<string, unknown> }>>`SELECT mode, status, summary FROM disaster_runs WHERE run_id = ${runId}`)[0];
  const cpObjects = () => [...w.bucket.objects.keys()].filter((k) => k.startsWith(targetPrefix(w.cpId, 'control-plane', 'control-plane')) && k.endsWith('.dump.enc'))
    .sort((a, b) => w.bucket.objects.get(b)!.lastModified.getTime() - w.bucket.objects.get(a)!.lastModified.getTime());

  it('T21: pass — rehearse rows in the REAL control plane (intended → created → rehearsed-deleted); proof rows only in the copy; the copy deleted; target and counts on the run row', async () => {
    // Look inside the copy just before it is deleted: the dry-run reconcile's proof rows are there.
    const base = worldDeps(w, { logs: [], emails: [] }).neon;
    let copyProofs: string[] | null = null;
    const neon: NeonApi = {
      ...base,
      async deleteProject(id) {
        const p = w.neon.projects.get(id)!;
        if (REHEARSAL_RE.test(p.name) && copyProofs === null) {
          const sql = postgres(clientUrl(connectUrl(p.connectionUri!, w.neon.hostMap)), { max: 1, onnotice: () => {} });
          try { copyProofs = (await sql<Array<{ s: string }>>`SELECT status AS s FROM disaster_actions WHERE kind = 'proof' AND tenant_id = ${w.tenants[0].id}`).map((x) => x.s); } finally { await sql.end({ timeout: 5 }); }
        }
        return base.deleteProject(id);
      },
    };
    const r = await rehearse({ neon });
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    expect(r.outcome?.results[0]).toMatchObject({ result: 'rehearsed', backupKey: cpObjects()[0] });
    const [copy] = copies();
    expect(copy.deleted).toBe(true);
    expect((await rows(r.args.runId)).map((x) => [x.kind, x.status, x.tenantId, x.projectName])).toEqual([
      ['rehearse', 'intended', null, copy.name], ['rehearse', 'created', null, copy.name], ['rehearse', 'rehearsed-deleted', null, copy.name],
    ]);
    expect(copyProofs).toEqual(['gone']);
    expect(await w.cpSql`SELECT 1 FROM disaster_actions WHERE run_id = ${r.args.runId} AND kind = 'proof'`).toHaveLength(0);
    const row = await runRow(r.args.runId);
    expect(row).toMatchObject({ mode: 'rehearse', status: 'pass' });
    expect(row.summary).toMatchObject({ target: 'control-plane', reconcile: { dryRun: true, counts: expect.objectContaining({ lost: 1 }) } });
    expect(r.emails[0].message).toContain('the copy');
    expect(await w.cpSql`SELECT 1 FROM ops_alerts WHERE kind = 'window-project'`).toHaveLength(0); // R4 lists, raises nothing
  }, 180_000);

  it('T21: the delete failing → fail, the copy named, its latest row `failed` (the leftover check lists it after 6 h)', async () => {
    const base = worldDeps(w, { logs: [], emails: [] }).neon;
    const neon: NeonApi = { ...base, async deleteProject(id) { if (REHEARSAL_RE.test(w.neon.projects.get(id)!.name)) throw new Error('neon down'); return base.deleteProject(id); } };
    const r = await rehearse({ neon });
    expect(r.exitCode).toBe(1);
    const [copy] = copies();
    expect(copy.deleted).toBe(false);
    expect(r.outcome?.results[0]).toMatchObject({ result: 'cleanup-failed' });
    expect(r.emails[0].message).toContain(copy.id);
    const last = (await rows(r.args.runId)).at(-1)!;
    expect(last).toMatchObject({ kind: 'rehearse', status: 'failed', newProjectId: copy.id, projectName: copy.name });
    w.neon.markDeleted(copy.id);
  }, 180_000);

  it('T21: the reconcile throwing → fail; the copy is still deleted', async () => {
    const r = await rehearse({ disasterLogReader: { async rebuildLines() { throw new Error('logs down'); } } });
    expect(r.exitCode).toBe(1);
    expect(r.outcome?.results[0].result).toBe('reconcile-failed');
    expect(copies().every((p) => p.deleted)).toBe(true);
    expect((await rows(r.args.runId)).at(-1)?.status).toBe('rehearsed-deleted');
  }, 180_000);

  it('T21: unknown counts never fail it (informational)', async () => {
    const real = pgConnector({ hostMap: w.neon.hostMap });
    const connector: Connector = async (url) => (url === RESTORE_TEST_URL || url.includes(w.cp.name) ? real(url) : { cls: 'unknown', code: null });
    const r = await rehearse({ connector });
    expect(r.exitCode, r.logs.join('\n')).toBe(0);
    expect((await runRow(r.args.runId)).summary).toMatchObject({ reconcile: { counts: expect.objectContaining({ unknown: 1 }) } });
  }, 180_000);

  it('T21: an integrity failure retries with a distinct name in the same minute, and deletes the failed copy', async () => {
    const newest = cpObjects()[0];
    const obj = w.bucket.objects.get(newest)!;
    const saved = Buffer.from(obj.bytes);
    obj.bytes = Buffer.concat([saved.subarray(0, saved.length - 1), Buffer.from([saved[saved.length - 1] ^ 0xff])]);
    try {
      const r = await rehearse();
      expect(r.exitCode, r.logs.join('\n')).toBe(0);
      const names = copies().map((p) => p.name);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      expect(names.map((n) => n.split('-').at(-1)).sort()).toEqual(['1', '2']);
      expect(copies().every((p) => p.deleted)).toBe(true);
    } finally {
      obj.bytes = saved;
    }
  }, 180_000);

  it('T20: target written at INSERT for every mode; the outer catch and the abandoned close keep it; the summary merges', async () => {
    // A workspace press's row says workspace; a control-plane rehearsal's says control-plane (above).
    const ws = await press(w, { targets: [w.tenants[1].id] });
    expect((await runRow(ws.args.runId)).summary.target).toBe('workspace');
    // The outer catch (a throw right after the INSERT, at the start line): the row is closed `fail` and keeps its INSERT summary.
    const cap: RunCapture = { logs: [], emails: [] };
    const runId = `gh-${randomUUID().slice(0, 6)}-1`;
    const d = worldDeps(w, cap, { restoreTestUrl: RESTORE_TEST_URL, disasterLogReader: noLines, log: (l) => { cap.logs.push(l); if (l.startsWith('disaster rehearse run ')) throw new Error('injected'); } });
    const r = await runDisaster({ mode: 'rehearse', targets: 'control-plane', override: 'none', runId }, d);
    expect(r.exitCode).toBe(1);
    expect(cap.logs.some((l) => l.startsWith('fatal: '))).toBe(true);
    expect(await runRow(runId)).toMatchObject({ status: 'fail', summary: { target: 'control-plane' } });
    // The abandoned close (a stale running row closed by the next press) keeps `target` and adds its detail.
    const stale = `gh-${randomUUID().slice(0, 6)}-1`;
    await w.cpSql`INSERT INTO disaster_runs (run_id, mode, started_at, status, summary) VALUES (${stale}, 'rehearse', now() - interval '1 hour', 'running', ${w.cpSql.json({ target: 'control-plane', backupStartedAt: '2026-11-18T00:00:00.000Z' })})`;
    await press(w, { targets: [w.tenants[1].id] });
    expect(await runRow(stale)).toMatchObject({ status: 'fail', summary: { target: 'control-plane', backupStartedAt: '2026-11-18T00:00:00.000Z', detail: 'abandoned' } });
  }, 240_000);
});
