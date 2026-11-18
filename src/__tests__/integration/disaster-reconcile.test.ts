import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '@/lib/encryption';
import { tenantDatabaseName } from '@/lib/tenant/db-name';
import {
  CAN_RUN, RESTORE_TEST_URL, createWorld, deps as worldDeps, press, type RunCapture, type World,
} from './disaster-harness';
import { createScratchDb, dropScratchDb } from './backup-helpers';
import { runReconcile, type ReconcileInput, type ReconcileResult } from '../../../scripts/backup/disaster-reconcile';
import { parseRebuildLine, type DisasterLogReader, type RebuildLine } from '../../../scripts/backup/lib/log-reader';
import { controlPlaneRebuildName, controlPlaneRehearsalName, rebuildName } from '../../../scripts/backup/lib/project-names';
import { poolerOf, fakeHost } from '../helpers/fake-neon';
import type { DisasterDeps } from '../../../scripts/backup/disaster';

/**
 * feature-plan-control-plane-disaster.md §11 T14–T19, T29 (and T15's 3c `all-lost` half): the window reconcile against
 * scratch control planes (one per scenario, so no assertion depends on another test's rows), the fake Neon API, the
 * local 28P01 proxy stand-in, and a fake disaster log reader. No fixed sleeps.
 */

const NOW = new Date();
const HOUR = 3600_000;
const WINDOW_START = new Date(NOW.getTime() - 6 * HOUR);
const WINDOW_END = new Date(NOW.getTime() - 1 * HOUR);
const NEW_CP_HOST = 'ep-new-control-plane.us-east-1.aws.neon.tech';
const SHA = 'c'.repeat(64);

describe.skipIf(!CAN_RUN)('the window reconcile', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(1, 'test-rc'); }, 240_000);
  afterAll(async () => { await w?.close(); });

  interface Scenario { name: string; url: string; sql: postgres.Sql; close(): Promise<void> }
  const scenario = async (): Promise<Scenario> => {
    const db = await createScratchDb('cp', { migrateControlPlane: true });
    const sql = postgres(db.url, { max: 4, onnotice: () => {} });
    return { ...db, sql, async close() { await sql.end({ timeout: 5 }); await dropScratchDb(db.name); } };
  };
  /** A Neon-shaped pooled URL whose host the fake maps (live: the local original database; gone: the 28P01 proxy). */
  const urlOn = (host: string) => { const u = new URL(w.original.url); u.hostname = poolerOf(host); u.port = ''; return u.toString(); };
  type State = 'live' | 'gone' | 'recoverable' | 'answers' | 'none';
  interface T { id: string; slug: string; projectId: string | null; url: string }
  const addTenant = async (s: Scenario, o: { state: State; status?: string; due?: boolean }): Promise<T> => {
    const id = randomUUID();
    const slug = `rc-${id.slice(0, 8)}`;
    const host = fakeHost();
    let projectId: string | null = null;
    if (o.state !== 'none') {
      const p = w.neon.addProject({ name: `cadenzpoint-${slug}`, host, createdAt: new Date(NOW.getTime() - 30 * 24 * HOUR) });
      projectId = p.id;
      if (o.state === 'gone' || o.state === 'answers') w.neon.purge(p.id);
      if (o.state === 'recoverable') w.neon.markDeleted(p.id);
      if (o.state === 'answers') { const local = new URL(w.original.url); for (const h of [host, poolerOf(host)]) w.neon.hostMap[h] = { host: local.hostname, port: Number(local.port || 5432) }; }
    }
    const url = urlOn(host);
    const due = o.due ? new Date(NOW.getTime() - 24 * HOUR) : null;
    await s.sql`INSERT INTO tenants (id, slug, name, status, db_url_encrypted, neon_project_id, deletion_scheduled_for)
      VALUES (${id}, ${slug}, ${'RC ' + slug}, ${o.status ?? 'active'}, ${encrypt(url)}, ${projectId}, ${due})`;
    return { id, slug, projectId, url };
  };
  /** A live 3c rebuild project for a tenant (the chain's end): the right database name and an owner role. */
  const addEnd = (t: T, o: { tryNo?: number } = {}) => w.neon.addProject({ name: rebuildName(t.id, new Date(WINDOW_START.getTime() + HOUR), o.tryNo ?? 1), databaseName: tenantDatabaseName(t.slug), owner: 'tenant_owner', createdAt: new Date(WINDOW_START.getTime() + HOUR) });
  const linked = (t: string, a: string, b: string, at: number, healed = false): string => `LINKED ${t} ${a} ${b} v1/prod/tenant/${t}/2026/11/18/ecs-1-aaaa1111.dump.enc ${SHA}${healed ? ' (healed by the re-read)' : ''}`;
  const reader = (entries: Array<[string, number]>): DisasterLogReader => {
    // Returned shuffled (reversed): the reconcile orders by the event time, never by arrival.
    const parsed = entries.map(([m, at]) => parseRebuildLine(m, at)).filter((x): x is RebuildLine => x !== null);
    return { async rebuildLines(since) { return parsed.filter((l) => l.at >= since.getTime()).reverse(); } };
  };
  const at = (h: number) => WINDOW_START.getTime() + h * HOUR;
  const run = async (s: Scenario, o: { lines?: Array<[string, number]>; dryRun?: boolean; over?: Partial<DisasterDeps>; cpDirectHost?: string; start?: Date; end?: Date; ids?: string[] } = {}) => {
    const cap: RunCapture = { logs: [], emails: [] };
    const input: ReconcileInput = {
      cp: s.sql, cpDirectHost: o.cpDirectHost ?? NEW_CP_HOST, windowStart: o.start ?? WINDOW_START, windowEnd: o.end ?? WINDOW_END, runId: `test-rc-${randomUUID().slice(0, 6)}`,
      deps: worldDeps(w, cap, { restoreTestUrl: RESTORE_TEST_URL, disasterLogReader: reader(o.lines ?? []), ...o.over }),
      dryRun: o.dryRun ?? false, now: () => new Date(), sleep: async () => {}, log: (l) => cap.logs.push(l), signal: new AbortController().signal,
      controlPlaneProjectIds: o.ids ?? [w.controlPlaneProjectId],
    };
    const r = await runReconcile(input);
    return { r, logs: cap.logs, email: r.email.join('\n') };
  };
  const row = async (s: Scenario, id: string) => (await s.sql<Array<{ p: string | null; u: string | null; v: number }>>`SELECT neon_project_id AS p, db_url_encrypted AS u, lifecycle_version AS v FROM tenants WHERE id = ${id}`)[0];
  const proofs = async (s: Scenario, id: string) => (await s.sql<Array<{ status: string }>>`SELECT status FROM disaster_actions WHERE tenant_id = ${id} AND kind = 'proof' ORDER BY at`).map((x) => x.status);
  const cls = (r: ReconcileResult, id: string) => r.classes.get(id)?.cls;

  describe('T14: R2, rebuilds made in the window', () => {
    it('old→n1→n2 with n1 gone, lines shuffled → ONE update old→n2 (sslmode only), RELINKED; audit, linked, the watch; a re-run is "already applied"; R2 writes no SWITCHING/LINKED', async () => {
      const s = await scenario();
      try {
        const a = await addTenant(s, { state: 'gone' });
        const n1 = addEnd(a, { tryNo: 1 });
        w.neon.purge(n1.id); // the middle project is gone by design
        const n2 = addEnd(a, { tryNo: 2 });
        const lines: Array<[string, number]> = [[linked(a.id, a.projectId!, n1.id, at(1)), at(1)], [linked(a.id, n1.id, n2.id, at(2)), at(2)]];
        const before = await row(s, a.id);
        const first = await run(s, { lines });
        const after = await row(s, a.id);
        expect(after.p).toBe(n2.id);
        expect(after.v).toBe(before.v + 1);
        const stored = decrypt(after.u!);
        expect(new URL(stored).hostname).toBe(poolerOf(n2.endpoints[0].host));
        expect(new URL(stored).searchParams.get('channel_binding')).toBeNull(); // D5: sslmode only
        expect(new URL(stored).searchParams.get('sslmode')).toBe('require');
        expect(new URL(stored).pathname).toBe(`/${tenantDatabaseName(a.slug)}`);
        expect(first.logs).toContain(`RELINKED ${a.id} ${a.projectId} ${n2.id}`);
        expect(first.logs.some((l) => /^(SWITCHING|LINKED) /.test(l))).toBe(false);
        expect(first.r.counts.reapplied).toBe(1);
        expect(cls(first.r, a.id)).toBe('fine');
        const [audit] = await s.sql<Array<{ detail: string }>>`SELECT detail FROM tenant_audit_events WHERE tenant_id = ${a.id} AND kind = 'database-rebuilt'`;
        expect(JSON.parse(audit.detail)).toMatchObject({ reapplied: true, chain: [a.projectId, n1.id, n2.id] });
        expect(await s.sql`SELECT 1 FROM disaster_actions WHERE tenant_id = ${a.id} AND kind = 'rebuild' AND status = 'linked' AND new_project_id = ${n2.id}`).toHaveLength(1);
        expect(await s.sql`SELECT 1 FROM ops_alerts WHERE kind = 'rebuild-original-watch' AND dedup_key = ${a.projectId} AND resolved_at IS NULL`).toHaveLength(1);
        // A re-run is quiet: already applied, nothing listed, nothing re-linked.
        const again = await run(s, { lines: [...lines, [`RELINKED ${a.id} ${a.projectId} ${n2.id}`, at(5)]] });
        expect(again.r.counts.reapplied).toBe(0);
        expect(again.r.counts['already-applied']).toBe(1);
        expect(again.logs.some((l) => l.startsWith('RELINKED'))).toBe(false);
        expect((await row(s, a.id)).v).toBe(after.v);
        expect(cls(again.r, a.id)).toBe('fine');
      } finally { await s.close(); }
    }, 60_000);

    it('a healed LINKED with a real old id is a committed link; a healed `-` is listed; a SWITCHING with no LINKED at the end is listed; an end that 404s is listed', async () => {
      const s = await scenario();
      try {
        const healed = await addTenant(s, { state: 'gone' });
        const hEnd = addEnd(healed);
        const dash = await addTenant(s, { state: 'gone' });
        const dEnd = addEnd(dash);
        const sw = await addTenant(s, { state: 'gone' });
        const swEnd = addEnd(sw);
        const gone = await addTenant(s, { state: 'gone' });
        const gEnd = addEnd(gone);
        w.neon.purge(gEnd.id);
        const r = await run(s, { lines: [
          [linked(healed.id, healed.projectId!, hEnd.id, at(1), true), at(1)],
          [`LINKED ${dash.id} - ${dEnd.id} - - (healed by the re-read)`, at(1)],
          [`SWITCHING ${sw.id} ${sw.projectId} ${swEnd.id} v1/k ${SHA}`, at(1)],
          [linked(gone.id, gone.projectId!, gEnd.id, at(1)), at(1)],
        ] });
        expect((await row(s, healed.id)).p).toBe(hEnd.id);
        for (const t of [dash, sw, gone]) {
          expect((await row(s, t.id)).p, t.slug).toBe(t.projectId); // never applied
          expect(cls(r.r, t.id), t.slug).toBe('unconfirmed-rebuild');
          expect(await proofs(s, t.id), t.slug).toEqual(['chain-unconfirmed']);
        }
        expect(r.r.classes.get(sw.id)?.detail).toContain('no matching LINKED');
        expect(r.r.classes.get(gone.id)?.detail).toContain('is gone (404)');
      } finally { await s.close(); }
    }, 60_000);

    it('a row that is due, or on a project outside the chain, is never applied; the guard refuses an end on the control plane\'s host', async () => {
      const s = await scenario();
      try {
        const due = await addTenant(s, { state: 'gone', due: true });
        const dueEnd = addEnd(due);
        const moved = await addTenant(s, { state: 'live' });
        const movedEnd = addEnd(moved);
        const cpHost = await addTenant(s, { state: 'gone' });
        const cpEnd = addEnd(cpHost);
        const r = await run(s, {
          cpDirectHost: cpEnd.endpoints[0].host,
          lines: [
            [linked(due.id, due.projectId!, dueEnd.id, at(1)), at(1)],
            [linked(moved.id, 'prj-someother', movedEnd.id, at(1)), at(1)],
            [linked(cpHost.id, cpHost.projectId!, cpEnd.id, at(1)), at(1)],
          ],
        });
        for (const t of [due, moved, cpHost]) expect((await row(s, t.id)).p, t.slug).toBe(t.projectId);
        expect(r.r.classes.get(due.id)?.detail).toContain('due for deletion');
        expect(r.r.classes.get(moved.id)?.detail).toContain('outside every rebuild chain');
        expect(r.r.classes.get(cpHost.id)?.detail).toContain("control plane's");
        expect(r.r.counts.reapplied).toBe(0);
      } finally { await s.close(); }
    }, 60_000);

    it('T15/F12: the end\'s connection details 503 → unknown (re-press); 403 → listed (chain-unconfirmed); a 403 on the branches or databases call too', async () => {
      const s = await scenario();
      try {
        const t503 = await addTenant(s, { state: 'gone' });
        const e503 = addEnd(t503);
        const t403 = await addTenant(s, { state: 'gone' });
        const e403 = addEnd(t403);
        const tb = await addTenant(s, { state: 'gone' });
        const eb = addEnd(tb);
        const td = await addTenant(s, { state: 'gone' });
        const ed = addEnd(td);
        w.neon.script('GET /projects/:id/connection_uri', [503], e503.id);
        w.neon.script('GET /projects/:id/connection_uri', [403], e403.id);
        w.neon.script('GET /projects/:id/branches', [403], eb.id);
        w.neon.script('GET /projects/:id/branches/:branch/databases', [404], ed.id);
        const r = await run(s, { lines: [t503, t403, tb, td].map((t, i) => [linked(t.id, t.projectId!, [e503, e403, eb, ed][i].id, at(1)), at(1)] as [string, number]) });
        expect(cls(r.r, t503.id)).toBe('unknown');
        expect(await proofs(s, t503.id)).toEqual([]);
        for (const t of [t403, tb, td]) expect(cls(r.r, t.id), t.slug).toBe('unconfirmed-rebuild');
        for (const t of [t503, t403, tb, td]) expect((await row(s, t.id)).p).toBe(t.projectId);
      } finally { await s.close(); }
    }, 60_000);
  });

  describe('T15: R3, every row of the table', () => {
    it('fine, in progress (deleting and provisioning), lost, deleted in window (due or deleting), recoverable not due, stale project id, no project id; proof rows for the decisive ones only', async () => {
      const s = await scenario();
      try {
        const fine = await addTenant(s, { state: 'live' });
        const delLive = await addTenant(s, { state: 'live', status: 'deleting' });
        const provLive = await addTenant(s, { state: 'live', status: 'provisioning' });
        const lost = await addTenant(s, { state: 'gone' });
        const dueGone = await addTenant(s, { state: 'gone', due: true });
        const deletingGone = await addTenant(s, { state: 'recoverable', status: 'deleting' });
        const rec = await addTenant(s, { state: 'recoverable' });
        const stale = await addTenant(s, { state: 'answers' });
        const none = await addTenant(s, { state: 'none' });
        const r = await run(s);
        const want: Array<[T, string, string[]]> = [
          [fine, 'fine', []], [delLive, 'in-progress', []], [provLive, 'in-progress', []], [lost, 'lost', ['gone']], [dueGone, 'window-deleted', ['window-deleted']],
          [deletingGone, 'window-deleted', ['window-deleted']], [rec, 'recoverable-deleted', ['recoverable-deleted']], [stale, 'stale-project-id', ['refused:reachable']], [none, 'unknown', []],
        ];
        for (const [t, c, p] of want) {
          expect(cls(r.r, t.id), t.slug).toBe(c);
          expect(await proofs(s, t.id), t.slug).toEqual(p);
        }
        expect(r.email).toContain('press mode workspace with all-lost'); // no unconfirmed chain: all-lost offered
        expect(r.email).toContain(lost.slug);
      } finally { await s.close(); }
    }, 60_000);

    it('R1 failing (an incomplete organisation list) → every tenant unknown, no proof rows, no window projects; the email says so', async () => {
      const s = await scenario();
      try {
        const lost = await addTenant(s, { state: 'gone' });
        const fine = await addTenant(s, { state: 'live' });
        w.neon.unavailable = { ids: ['prj-x'], calls: 1 };
        const r = await run(s);
        expect(r.r.r1Failed).toBe(true);
        for (const t of [lost, fine]) { expect(cls(r.r, t.id)).toBe('unknown'); expect(await proofs(s, t.id)).toEqual([]); }
        expect(r.email).toContain('The shared proof failed');
      } finally { w.neon.unavailable = { ids: [], calls: 0 }; await s.close(); }
    }, 60_000);

    it('with an unconfirmed chain listed, the email prints the lost ids to press explicitly, never all-lost; 3c\'s all-lost then skips the chain-unconfirmed tenant', async () => {
      const s = await scenario();
      try {
        const lost = await addTenant(s, { state: 'gone' });
        const unc = await addTenant(s, { state: 'gone' });
        const uncEnd = addEnd(unc);
        const r = await run(s, { lines: [[`SWITCHING ${unc.id} ${unc.projectId} ${uncEnd.id} v1/k ${SHA}`, at(1)]] });
        expect(r.email).toContain(`pressing these ids explicitly (NOT all-lost`);
        expect(r.email).toContain(lost.id);
        expect(r.email).not.toContain('press mode workspace with all-lost');
        // 3c's all-lost against this control plane: the unconfirmed tenant is skipped (result unconfirmed-rebuild, ok).
        const ws = await press(w, { targets: 'all-lost' }, { controlPlaneUrl: s.url, restoreTestUrl: RESTORE_TEST_URL });
        const res = ws.outcome!.results.find((x) => x.tenantId === unc.id)!;
        expect(res.result).toBe('unconfirmed-rebuild');
        expect(ws.outcome!.results.find((x) => x.tenantId === lost.id)?.result).not.toBe('unconfirmed-rebuild');
      } finally { await s.close(); }
    }, 120_000);
  });

  describe('T17: R4, projects created in the window', () => {
    it('bounds, exclusions and types; an existing (resolved) alert is never reopened; raised once with an action row', async () => {
      const s = await scenario();
      try {
        const inWin = new Date(WINDOW_START.getTime() + 2 * HOUR);
        const ref = await addTenant(s, { state: 'live', status: 'deleted' }); // referenced by a row of any status
        w.neon.projects.get(ref.projectId!)!.createdAt = inWin.toISOString();
        const chainT = await addTenant(s, { state: 'gone' });
        const chainEnd = addEnd(chainT);
        const mk = (name: string, created: Date) => w.neon.addProject({ name, createdAt: created });
        const early = mk(`cadenzpoint-early-${randomUUID().slice(0, 6)}`, new Date(WINDOW_START.getTime() - 30 * 60_000));
        const late = mk(`cadenzpoint-late-${randomUUID().slice(0, 6)}`, new Date(WINDOW_END.getTime() + 60_000));
        const tooEarly = mk(`cadenzpoint-old-${randomUUID().slice(0, 6)}`, new Date(WINDOW_START.getTime() - 2 * HOUR));
        const rnd = mk('cadenzpoint-r-and-d', inWin);
        const rb = mk(rebuildName(randomUUID(), inWin, 1), inWin);
        const other = mk(`side-project-${randomUUID().slice(0, 6)}`, inWin);
        const excluded = [
          mk(controlPlaneRebuildName(inWin, 1), inWin), mk(controlPlaneRehearsalName(inWin, 1), inWin), mk('cadenzpoint-recoverable-canary', inWin),
        ];
        const cpOld = mk('cadenzpoint-control-prod', inWin);
        const resolved = mk(`cadenzpoint-resolved-${randomUUID().slice(0, 6)}`, inWin);
        await s.sql`INSERT INTO ops_alerts (scope, tenant_id, kind, dedup_key, detail, first_seen_at, last_seen_at, resolved_at)
          VALUES ('global', NULL, 'window-project', ${resolved.id}, '{}'::jsonb, now(), now(), now())`;
        w.neon.projects.get(w.restoreTestProjectId)!.createdAt = inWin.toISOString();
        const r = await run(s, { ids: [w.controlPlaneProjectId, cpOld.id], lines: [[linked(chainT.id, chainT.projectId!, chainEnd.id, at(1)), at(1)]] });
        const listed = new Map(r.r.windowProjects.map((p) => [p.projectId, p]));
        expect(listed.get(early.id)?.type).toBe('signup');
        expect(listed.get(rnd.id)).toMatchObject({ type: 'signup', slug: 'r-and-d' });
        expect(listed.get(rb.id)).toMatchObject({ type: 'rebuild', slug: null });
        expect(listed.get(other.id)).toMatchObject({ type: 'other', slug: null });
        for (const p of [late, tooEarly, ...excluded, cpOld, resolved, chainEnd, { id: ref.projectId! }, { id: w.restoreTestProjectId }]) expect(listed.has(p.id), p.id).toBe(false);
        const alerts = await s.sql<Array<{ k: string; detail: Record<string, unknown> }>>`SELECT dedup_key AS k, detail FROM ops_alerts WHERE kind = 'window-project' AND resolved_at IS NULL`;
        expect(alerts.map((a) => a.k).sort()).toEqual([...listed.keys()].sort());
        expect(alerts.find((a) => a.k === rnd.id)?.detail).toMatchObject({ projectId: rnd.id, name: 'cadenzpoint-r-and-d', slug: 'r-and-d', type: 'signup' });
        expect(await s.sql`SELECT 1 FROM disaster_actions WHERE kind = 'window-project' AND status = 'listed'`).toHaveLength(listed.size);
        // T19: a re-run raises nothing new (deduped by the "any alert" exclusion), and never reopens the resolved one.
        const again = await run(s, { ids: [w.controlPlaneProjectId, cpOld.id], lines: [[linked(chainT.id, chainT.projectId!, chainEnd.id, at(1)), at(1)]] });
        expect(again.r.windowProjects).toEqual([]);
        expect(await s.sql`SELECT 1 FROM ops_alerts WHERE kind = 'window-project' AND dedup_key = ${resolved.id} AND resolved_at IS NULL`).toHaveLength(0);
        for (const p of [early, late, tooEarly, rnd, rb, other, ...excluded, cpOld, resolved]) w.neon.purge(p.id);
      } finally { w.neon.projects.get(w.restoreTestProjectId)!.createdAt = new Date(0).toISOString(); await s.close(); }
    }, 60_000);
  });

  describe('T18: the mass warning', () => {
    it('at 3 deleted-in-window or recoverable workspaces, not at 2', async () => {
      const s = await scenario();
      try {
        await addTenant(s, { state: 'gone', due: true });
        await addTenant(s, { state: 'recoverable' });
        expect((await run(s)).email).not.toContain('POSSIBLE MASS DELETION');
        await addTenant(s, { state: 'gone', due: true });
        const r = await run(s);
        expect(r.email.split('\n')[0]).toContain('POSSIBLE MASS DELETION (3 workspaces');
      } finally { await s.close(); }
    }, 60_000);
  });

  describe('T19: mode reconcile, standalone', () => {
    it('without a control-plane run → no-rebuild (exit 1)', async () => {
      const s = await scenario();
      try {
        const r = await press(w, { mode: 'reconcile', targets: 'control-plane' }, { controlPlaneUrl: s.url, restoreTestUrl: RESTORE_TEST_URL, disasterLogReader: reader([]) });
        expect(r.exitCode).toBe(1);
        expect(r.outcome?.results[0].result).toBe('no-rebuild');
        const [run0] = await s.sql<Array<{ mode: string; status: string; summary: Record<string, unknown> }>>`SELECT mode, status, summary FROM disaster_runs`;
        expect(run0).toMatchObject({ mode: 'reconcile', status: 'fail' });
        expect(run0.summary.target).toBe('control-plane');
      } finally { await s.close(); }
    }, 60_000);

    it('when the control plane in SSM does not answer → repoint-first, emailed, no lock tried', async () => {
      let lockCalls = 0;
      const r = await press(w, { mode: 'reconcile', targets: 'control-plane' }, { controlPlaneUrl: 'postgres://u:p@127.0.0.1:1/gone', lockConnect: (() => { lockCalls++; throw new Error('x'); }) as never });
      expect(r.exitCode).toBe(1);
      expect(r.logs.join('\n')).toContain('refused: repoint-first');
      expect(r.emails[0].message).toContain('finish runbook B.5');
      expect(lockCalls).toBe(0);
    });

    it('with a control-plane run: the window from its summary; pass with unknowns listed (P1); the counts merged into the run row', async () => {
      const s = await scenario();
      try {
        await s.sql`INSERT INTO disaster_runs (run_id, mode, started_at, finished_at, status, summary) VALUES ('gh-old-1', 'control-plane', ${WINDOW_END}, ${WINDOW_END}, 'pass',
          ${s.sql.json({ target: 'control-plane', previousProjectId: 'prj-old', newProjectId: w.controlPlaneProjectId, backupStartedAt: WINDOW_START.toISOString(), cpRunStartedAt: WINDOW_END.toISOString() })})`;
        const none = await addTenant(s, { state: 'none' });
        const r = await press(w, { mode: 'reconcile', targets: 'control-plane' }, { controlPlaneUrl: s.url, restoreTestUrl: RESTORE_TEST_URL, disasterLogReader: reader([]) });
        expect(r.exitCode).toBe(0);
        expect(r.emails[0].subject).toContain('passed');
        expect(r.emails[0].message).toContain(`window is ${WINDOW_START.toISOString()} to ${WINDOW_END.toISOString()}`);
        expect(r.emails[0].message).toContain(none.id);
        const [mine] = await s.sql<Array<{ summary: Record<string, unknown> }>>`SELECT summary FROM disaster_runs WHERE mode = 'reconcile'`;
        expect(mine.summary).toMatchObject({ target: 'control-plane', reconcile: { counts: expect.objectContaining({ unknown: 1 }) } });
      } finally { await s.close(); }
    }, 60_000);
  });

  describe('T29: the email and the logs', () => {
    it('lists truncate at 200; logs carry ids only (no slug, URL or host)', async () => {
      const s = await scenario();
      try {
        const inWin = new Date(WINDOW_START.getTime() + HOUR);
        const made = Array.from({ length: 205 }, (_, i) => w.neon.addProject({ name: `cadenzpoint-trunc-${i}-${randomUUID().slice(0, 4)}`, createdAt: inWin }));
        const t = await addTenant(s, { state: 'gone' });
        const r = await run(s, { dryRun: true });
        expect(r.email).toMatch(/… and (\d+) more/);
        expect(Number(/… and (\d+) more/.exec(r.email)![1])).toBeGreaterThanOrEqual(5);
        const text = r.logs.join('\n');
        for (const bad of [t.slug, 'postgres://', 'postgresql://', 'neon.tech']) expect(text).not.toContain(bad);
        // dry run: nothing raised, no proof rows written for window projects
        expect(await s.sql`SELECT 1 FROM ops_alerts WHERE kind = 'window-project'`).toHaveLength(0);
        for (const p of made) w.neon.purge(p.id);
      } finally { await s.close(); }
    }, 120_000);
  });
});
