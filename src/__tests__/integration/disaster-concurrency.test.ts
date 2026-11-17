import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DISASTER_LOCK_KEY } from '@/lib/tenant/backup-locks';
import { CAN_RUN, PG_RESTORE, createWorld, deps, press, makeGone, tenantRow, actions, fakeEcs, FAST_LOCK, type World, type WorldTenant, type RunCapture } from './disaster-harness';
import { acquireLock } from '../../../scripts/backup/lib/locks';
import { MODES, runDisaster, type RunContext } from '../../../scripts/backup/disaster';
import { stepEnv } from '../../../scripts/backup/disaster-workspace';
import { cleanupProject } from '../../../scripts/backup/disaster-steps';
import { loadTenant } from '../../../scripts/backup/lib/disaster-sql';

/**
 * feature-plan-disaster-restore.md §11 R9 (and D8's hard-exit timer): one run at a time, SIGTERM at every point of the
 * rebuild, a lost commit acknowledgement, a switch paused before COMMIT, and a lock timeout in cleanup. `linked` is
 * terminal: no path deletes a project the tenant row points at.
 */

describe.skipIf(!CAN_RUN)('R9: concurrency and termination', () => {
  let w: World;
  let next = 0;
  const take = (): WorldTenant => w.tenants[next++];
  const createdFor = (t: WorldTenant) => [...w.neon.projects.values()].filter((p) => p.name.startsWith(`cadenzpoint-r-${t.id.slice(0, 8)}-`));

  beforeAll(async () => { w = await createWorld(12, 'test-dr-r9'); }, 180_000);
  afterAll(async () => { await w?.close(); });

  it('a second run exits: the disaster lock is held (waited for, then refused), or an older task is running (oldest wins)', async () => {
    const t = take();
    const held = (await acquireLock(w.cp.url, DISASTER_LOCK_KEY, { timing: FAST_LOCK }))!;
    try {
      const r = await press(w, { targets: [t.id] }, { lockWaitMs: 300, lockRetryMs: 100 });
      expect(r.exitCode).toBe(1);
      expect(r.logs.join('\n')).toContain('the disaster lock is still held');
    } finally {
      await held.release();
    }
    const older = { taskArn: 'arn:aws:ecs:us-east-1:1:task/cadenzpoint-backup/aaa', startedBy: 'gh-0-1', createdAt: new Date('2026-11-17T11:00:00Z') };
    const r2 = await press(w, { targets: [t.id] }, { ecs: fakeEcs({ others: [older] }) });
    expect(r2.exitCode).toBe(1);
    expect(r2.logs.join('\n')).toContain('another disaster task is running');
    // The same createdAt: the smaller ARN wins.
    const tie = { ...older, createdAt: new Date('2026-11-17T12:00:00Z') };
    expect((await press(w, { targets: [t.id] }, { ecs: fakeEcs({ others: [tie] }) })).exitCode).toBe(1);
    expect(await actions(w, t.id)).toEqual([]);
  });

  it('SIGTERM mid-restore → cleanup: the project is deleted after the locked re-read, the row unchanged', async () => {
    const t = take();
    makeGone(w, t);
    const before = await tenantRow(w, t.id);
    const dir = mkdtempSync(path.join(tmpdir(), 'dr-slow-'));
    const slow = path.join(dir, 'pg_restore');
    writeFileSync(slow, `#!/bin/bash\nsleep 3\nexec "${PG_RESTORE}" "$@"\n`);
    chmodSync(slow, 0o755);
    const stop = new AbortController();
    const running = press(w, { targets: [t.id] }, { pgRestoreBin: slow, stopSignal: stop.signal });
    for (let i = 0; i < 200 && !(await actions(w, t.id)).some((a) => a.status === 'created'); i++) await new Promise((r) => setTimeout(r, 25));
    stop.abort('stopped');
    const r = await running;
    expect(r.outcome!.results[0].result).toBe('not-finished');
    expect((await tenantRow(w, t.id)).neonProjectId).toBe(before.neonProjectId);
    expect(createdFor(t).every((p) => p.deleted)).toBe(true);
    expect((await actions(w, t.id)).map((a) => a.status)).toEqual(['gone', 'intended', 'created', 'deleted']);
  }, 30_000);

  it('SIGTERM right after the commit → linked, never deleted', async () => {
    const t = take();
    makeGone(w, t);
    const stop = new AbortController();
    const r = await press(w, { targets: [t.id] }, { stopSignal: stop.signal, hooks: { afterCommit: async () => { stop.abort('stopped'); } } });
    expect(r.outcome!.results[0].result).toBe('linked');
    const row = await tenantRow(w, t.id);
    expect(w.neon.projects.get(row.neonProjectId!)!.deleted).toBe(false);
    expect((await actions(w, t.id)).some((a) => a.status === 'deleted')).toBe(false);
  }, 30_000);

  it('a dropped commit acknowledgement → the locked re-read finds the new project: linked (healed), kept', async () => {
    const t = take();
    makeGone(w, t);
    const r = await press(w, { targets: [t.id] }, { hooks: { afterCommit: async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); } } });
    expect(r.outcome!.results[0].result, r.logs.join('\n')).toBe('linked');
    const row = await tenantRow(w, t.id);
    expect(w.neon.projects.get(row.neonProjectId!)!.deleted).toBe(false);
    expect((await actions(w, t.id)).filter((a) => a.status === 'linked').map((a) => a.detail)).toEqual([null, 'healed: the switch committed']);
    expect(r.logs.some((l) => l.includes('(healed by the re-read)'))).toBe(true);
  }, 30_000);

  it('a switch paused before COMMIT, then SIGTERM: the commit lands and the project is kept (linked is terminal)', async () => {
    const t = take();
    makeGone(w, t);
    const stop = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const running = press(w, { targets: [t.id] }, { stopSignal: stop.signal, hooks: { beforeCommit: async () => { stop.abort('stopped'); setTimeout(release, 300); await gate; } } });
    const r = await running;
    expect(r.outcome!.results[0].result).toBe('linked');
    const row = await tenantRow(w, t.id);
    expect(row.neonProjectId).not.toBe(t.projectId);
    expect(w.neon.projects.get(row.neonProjectId!)!.deleted).toBe(false);
  }, 30_000);

  /** A StepEnv for calling cleanup directly (the same wiring as a run). */
  async function directEnv(cap: RunCapture, timing: Record<string, unknown> = {}) {
    const d = deps(w, cap, { timing: { recoverablePolls: 1, recoverablePollMs: 1, overrideGapMs: 1, lockRetryMs: 10, cleanupRetryMs: 50, ...timing } });
    const cp = postgres(w.cp.url, { max: 2, onnotice: () => {} });
    const ctx: RunContext = { args: { mode: 'workspace', targets: [], override: 'none', runId: 'gh-direct-1' }, deps: d, cp, runRowId: 'x', signal: new AbortController().signal, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: d.log };
    return { env: stepEnv(ctx, 'rebuild'), cp };
  }

  it('cleanup blocks on the tenant lock while a switch is still committing, and keeps the project once the commit lands', async () => {
    const t = take();
    const p = w.neon.addProject({ name: `cadenzpoint-r-${t.id.slice(0, 8)}-20261117000000-1` });
    const cap: RunCapture = { logs: [], emails: [] };
    const { env, cp } = await directEnv(cap);
    const other = postgres(w.cp.url, { max: 1, onnotice: () => {} });
    try {
      let commit!: () => void;
      const committed = new Promise<void>((r) => { commit = r; });
      const switching = other.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + t.id}))`;
        await tx`UPDATE tenants SET neon_project_id = ${p.id} WHERE id = ${t.id}`;
        await committed;
      });
      await new Promise((r) => setTimeout(r, 100));
      const facts = (await loadTenant(cp, t.id))!;
      const cleaning = cleanupProject(env, facts, { id: p.id, name: p.name }, { budgetMs: 5_000, lockedReRead: true, oldProjectId: t.projectId });
      await new Promise((r) => setTimeout(r, 300));
      commit();
      await switching;
      expect(await cleaning).toBe('linked');
      expect(w.neon.projects.get(p.id)!.deleted).toBe(false);
    } finally {
      await other.end({ timeout: 5 });
      await cp.end({ timeout: 5 });
    }
  });

  it('a lock timeout in cleanup (retried within the budget) → `failed`, nothing deleted', async () => {
    const t = take();
    const p = w.neon.addProject({ name: `cadenzpoint-r-${t.id.slice(0, 8)}-20261117000001-1` });
    const cap: RunCapture = { logs: [], emails: [] };
    const { env, cp } = await directEnv(cap, { cleanupLockTimeout: '100ms', cleanupBudgetMs: 400 });
    const holder = postgres(w.cp.url, { max: 1, onnotice: () => {} });
    try {
      let done!: () => void;
      const hold = new Promise<void>((r) => { done = r; });
      const holding = holder.begin(async (tx) => { await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + t.id}))`; await hold; });
      await new Promise((r) => setTimeout(r, 100));
      const facts = (await loadTenant(cp, t.id))!;
      expect(await cleanupProject(env, facts, { id: p.id, name: p.name }, { budgetMs: 400, lockedReRead: true, oldProjectId: t.projectId })).toBe('failed');
      done();
      await holding;
      expect(w.neon.projects.get(p.id)!.deleted).toBe(false);
      expect((await actions(w, t.id)).at(-1)).toMatchObject({ status: 'failed', detail: 'kept: the tenant row could not be re-read' });
    } finally {
      await holder.end({ timeout: 5 });
      await cp.end({ timeout: 5 });
    }
  });

  it('D8: the hard-exit timer fires 5 minutes (here: ms) after the deadline when a run hangs', async () => {
    const original = MODES.workspace;
    let unblock!: () => void;
    MODES.workspace = () => new Promise((r) => { unblock = () => r({ pass: false, results: [], email: [] }); });
    const exits: number[] = [];
    try {
      const cap: RunCapture = { logs: [], emails: [] };
      const running = runDisaster({ mode: 'workspace', targets: [take().id], override: 'none', runId: 'gh-hang-1' },
        deps(w, cap, { deadlineMs: 50, hardExitAfterDeadlineMs: 50, hardExit: (c) => { exits.push(c); unblock(); } }));
      await running;
      expect(exits).toEqual([1]);
      expect(cap.logs).toContain('hard exit: still running 5 minutes after the deadline');
    } finally {
      MODES.workspace = original;
    }
  });
});
