/**
 * The `restore-test` command (feature-plan-database-backups.md §6.7; state tables §7.2 and §7.3).
 *
 * Weekly (Mondays 08:17 UTC) plus a daily catch-up (`--if-missed`). Restores the control plane plus the workspaces due
 * for a test into temporary `rt_…` databases in the dedicated restore-test project, checks every count, drops them.
 *
 *  1. Guards: RESTORE_TEST_LOCK_KEY (retried every 30 s for 10 min, else a `fail` row `lock held`); the start checks; the
 *     URL and server guards (rt-guards.ts). A guard failure inserts a `fail` row with the reason and exits 1.
 *  2. Earlier `running` rows are closed `fail` / `abandoned`.
 *  3. Sweep: leftover rt_ databases older than 1 h with no session are dropped.
 *  4. The run row; 5. the targets (targets.ts), `planned` set; 6. each target with RESTORE_TEST_CONCURRENCY workers:
 *     pick the newest listed object ≥ 30 min old with a sidecar and an `ok` row; create; stream + header check +
 *     pg_restore; the SHA-256; the sidecar; the counts; always drop; the result row.
 *  7. Finish `pass` / `fail`; SIGTERM records `FAIL:stopped` and closes the run `fail`; 8. the run deadline →
 *     `FAIL:not-reached`.
 */
import postgres from 'postgres';
import { RESTORE_TEST_LOCK_KEY } from '../../src/lib/tenant/backup-locks';
import { CONTROL_PLANE_ID, controlPlaneId, DUMP_SUFFIX, SIDECAR_SUFFIX, baseKey, rtDatabaseName, sidecarKeyFor, targetPrefix, type BackupTarget } from './lib/keys';
import { decryptBuffer, encryptionContext, type KeyringFactory } from './lib/crypto';
import type { BackupReader, BackupStore } from './lib/store';
import { restoreObject } from './lib/restore-stream';
import { childConnection, childEnv, clientUrl, withDatabase } from './lib/pg-url';
import { compareCounts, countTables, describeDiffs } from './lib/counts';
import { realSpawn, type SpawnFn } from './lib/child';
import { StageError, summaryOf } from './lib/summarize-error';
import { acquireLock, type Connect, type HeldLock, type LockTiming } from './lib/locks';
import { assertBackupTables, controlPlaneClient, insertPermissionCheck } from './lib/sql';
import { restoreServerRefusal, restoreUrlRefusal } from './lib/rt-guards';
import { createRtDatabase, dropRtDatabase, sweepRtDatabases } from './lib/rt-db';
import { chooseTargets, type EligibleWorkspace } from './lib/targets';
import { probesOk, restoreTestProbes } from './lib/probes';
import { HOUR, MINUTE, latestMondayUtc, runPool } from './lib/util';

export interface RestoreTestDeps {
  controlPlaneUrl: string;
  restoreTestUrl: string;
  reader: BackupReader;
  /** The probe calls (§6.13). Production always sets it. */
  store?: BackupStore;
  keyring: KeyringFactory;
  pgRestoreBin: string;
  runId: string;
  log: (line: string) => void;
  ifMissed?: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  spawn?: SpawnFn;
  random?: () => number;
  concurrency?: number;
  runDeadlineMs?: number;
  targetDeadlineMs?: number;
  lockRetryMs?: number;
  lockRetryMaxMs?: number;
  minObjectAgeMs?: number;
  /** Tests only, in-process: skips the same-host and Neon-region URL checks (CI's servers share localhost). */
  hostGuardOverride?: boolean;
  /** Tests only: replace the target choice (S10). */
  selectTargets?: (eligible: EligibleWorkspace[], now: Date) => EligibleWorkspace[];
  stopSignal?: AbortSignal;
  lockTiming?: LockTiming;
  lockConnect?: Connect;
  hooks?: {
    createDb?: (name: string) => Promise<void>;
    dropDb?: (name: string) => Promise<boolean>;
    /** Observe each rt_ database creation (S10's concurrency assertion). */
    onCreated?: (name: string) => void;
  };
}

export const RT_DEFAULTS = {
  concurrency: 2,
  runDeadlineMs: 6 * HOUR,
  targetDeadlineMs: 120 * MINUTE,
  lockRetryMs: 30_000,
  lockRetryMaxMs: 10 * MINUTE,
  minObjectAgeMs: 30 * MINUTE,
};

interface Target {
  target: BackupTarget;
  tenantId: string | null;
  slug: string;
}

interface ResultRow {
  target: BackupTarget;
  tenantId: string | null;
  slug: string;
  backupId: string | null;
  s3Key: string | null;
  backupStartedAt: Date | null;
  result: string;
  detail: string | null;
  durationMs: number;
}

type Sql = postgres.Sql;

/** A run that "completed" (§6.7): planned set, not abandoned, and pass, or fail with every planned result and none stopped/not reached. */
export const COMPLETED_RUN_SQL = `r.planned IS NOT NULL AND r.detail IS DISTINCT FROM 'abandoned' AND (r.status = 'pass' OR (r.status = 'fail'
  AND (SELECT count(*) FROM restore_test_results x WHERE x.test_run_id = r.id) = r.planned
  AND NOT EXISTS (SELECT 1 FROM restore_test_results x WHERE x.test_run_id = r.id AND x.result IN ('FAIL:stopped', 'FAIL:not-reached'))))`;

export async function runRestoreTest(deps: RestoreTestDeps): Promise<{ exitCode: number; results: ResultRow[] }> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const spawn = deps.spawn ?? realSpawn;
  const cfg = {
    concurrency: deps.concurrency ?? RT_DEFAULTS.concurrency,
    runDeadlineMs: deps.runDeadlineMs ?? RT_DEFAULTS.runDeadlineMs,
    targetDeadlineMs: deps.targetDeadlineMs ?? RT_DEFAULTS.targetDeadlineMs,
    lockRetryMs: deps.lockRetryMs ?? RT_DEFAULTS.lockRetryMs,
    lockRetryMaxMs: deps.lockRetryMaxMs ?? RT_DEFAULTS.lockRetryMaxMs,
    minObjectAgeMs: deps.minObjectAgeMs ?? RT_DEFAULTS.minObjectAgeMs,
  };
  const log = deps.log;
  const cpId = controlPlaneId(deps.controlPlaneUrl);
  const cp = controlPlaneClient(deps.controlPlaneUrl);
  const results: ResultRow[] = [];

  const insertRun = async (o: { status: 'running' | 'fail'; finished: boolean; detail: string | null; swept?: number }) => {
    const [row] = await cp<{ id: string }[]>`INSERT INTO restore_test_runs (run_id, started_at, finished_at, status, swept_test_dbs, deadline_ms, target_deadline_ms, detail)
      VALUES (${deps.runId}, ${now()}, ${o.finished ? now() : null}, ${o.status}, ${o.swept ?? 0}, ${cfg.runDeadlineMs}, ${cfg.targetDeadlineMs}, ${o.detail})
      RETURNING id::text AS id`;
    return row.id;
  };

  try {
    await assertBackupTables(cp);

    if (deps.ifMissed) {
      const since = latestMondayUtc(now());
      const [done] = await cp.unsafe(`SELECT EXISTS (SELECT 1 FROM restore_test_runs r WHERE r.started_at >= $1 AND ${COMPLETED_RUN_SQL}) AS done`, [since]) as Array<{ done: boolean }>;
      if (done.done) {
        log('catch-up: a completed restore test ran since Monday 00:00 UTC; nothing to do');
        return { exitCode: 0, results };
      }
      log('catch-up: no completed restore test since Monday 00:00 UTC; running one');
    }

    // ---- 1. guards -------------------------------------------------------------------------------------------------
    let lock: HeldLock | null = null;
    const lockStart = now().getTime();
    for (;;) {
      lock = await acquireLock(deps.controlPlaneUrl, RESTORE_TEST_LOCK_KEY, { timing: deps.lockTiming, connect: deps.lockConnect });
      if (lock || now().getTime() - lockStart >= cfg.lockRetryMaxMs) break;
      await sleep(cfg.lockRetryMs);
    }
    if (!lock) {
      await insertRun({ status: 'fail', finished: true, detail: 'lock held' });
      log('the restore-test lock is still held after retries; recorded "lock held"');
      return { exitCode: 1, results };
    }

    let admin: Sql | null = null;
    try {
      const urlRefusal = restoreUrlRefusal(deps.controlPlaneUrl, deps.restoreTestUrl, { hostGuardOverride: deps.hostGuardOverride });
      let refusal = urlRefusal;
      if (!refusal) {
        admin = postgres(clientUrl(deps.restoreTestUrl), { max: 2, connect_timeout: 30, onnotice: () => {} });
        try {
          refusal = await restoreServerRefusal(admin);
        } catch (e) {
          refusal = `cannot connect (${summaryOf('connect', e)})`;
        }
      }
      if (refusal) {
        await insertRun({ status: 'fail', finished: true, detail: `guard: ${refusal}` });
        log(`restore-test guard failed: ${refusal}`);
        return { exitCode: 1, results };
      }
      const rtAdmin = admin!;

      // ---- 2. close abandoned runs; 3. sweep; 4. the run row --------------------------------------------------------
      const abandoned = await cp`UPDATE restore_test_runs SET status = 'fail', finished_at = ${now()}, detail = 'abandoned' WHERE status = 'running' RETURNING id`;
      if (abandoned.length > 0) log(`closed ${abandoned.length} abandoned restore-test run(s)`);
      const swept = await sweepRtDatabases(rtAdmin, now(), { log });
      if (swept.dropped > 0) log(`dropped ${swept.dropped} leftover test database(s)`);
      const runRowId = await insertRun({ status: 'running', finished: false, detail: null, swept: swept.dropped });

      // ---- 5. targets --------------------------------------------------------------------------------------------
      const eligible = await eligibleWorkspaces(cp, now());
      const chosen = (deps.selectTargets ?? ((e, n) => chooseTargets(e, n, deps.random)))(eligible, now());
      const targets: Target[] = [{ target: 'control-plane', tenantId: null, slug: CONTROL_PLANE_ID },
        ...chosen.map((c) => ({ target: 'tenant' as const, tenantId: c.tenantId, slug: c.slug }))];
      await cp`UPDATE restore_test_runs SET planned = ${targets.length} WHERE id = ${runRowId}`;
      log(`restore test: control plane + ${chosen.length} workspace(s) of ${eligible.length} eligible`);

      // ---- 6. test ---------------------------------------------------------------------------------------------
      const runAbort = new AbortController();
      let resultInsertFailed = false;
      const runTimer = setTimeout(() => runAbort.abort('not-reached'), cfg.runDeadlineMs);
      const onStop = () => runAbort.abort('stopped');
      deps.stopSignal?.addEventListener('abort', onStop, { once: true });
      if (deps.stopSignal?.aborted) onStop();
      try {
        await runPool(targets, cfg.concurrency, async (t) => {
          const row = runAbort.signal.aborted
            ? { ...t, backupId: null, s3Key: null, backupStartedAt: null, result: `FAIL:${String(runAbort.signal.reason)}`, detail: null, durationMs: 0 }
            : await testOne(t, rtAdmin, runAbort.signal);
          results.push(row);
          log(`  ${row.slug.padEnd(24)} ${row.result}${row.detail ? ` (${row.detail})` : ''}`);
          // A failed insert must not stop the other workers mid-restore (their finally blocks drop their databases).
          try {
            await cp`INSERT INTO restore_test_results (test_run_id, run_id, target, tenant_id, backup_id, s3_key, backup_started_at, result, detail, duration_ms, tested_at)
              VALUES (${runRowId}, ${deps.runId}, ${row.target}, ${row.tenantId}, ${row.backupId}, ${row.s3Key}, ${row.backupStartedAt}, ${row.result}, ${row.detail}, ${row.durationMs}, ${now()})`;
          } catch (e) {
            resultInsertFailed = true;
            log(`${row.slug}: the result row could not be recorded (${summaryOf('row', e)})`);
          }
        });
      } finally {
        clearTimeout(runTimer);
        deps.stopSignal?.removeEventListener('abort', onStop);
      }

      // ---- 7. finish ---------------------------------------------------------------------------------------------
      const pass = !resultInsertFailed && results.length === targets.length && results.every((r) => r.result === 'PASS');
      const failures = results.filter((r) => r.result !== 'PASS').map((r) => `${r.slug}: ${r.result}`);
      await cp`UPDATE restore_test_runs SET status = ${pass ? 'pass' : 'fail'}, finished_at = ${now()},
        detail = ${failures.length ? failures.join('; ').slice(0, 2000) : null} WHERE id = ${runRowId}`;

      if (deps.store) {
        try {
          const detail = await restoreTestProbes(deps.store, { runId: deps.runId });
          await insertPermissionCheck(cp, { runId: deps.runId, role: 'restore-test', checkedAt: now(), ok: probesOk(detail), detail });
        } catch (e) {
          log(`permission probes failed: ${summaryOf('probes', e)}`);
        }
      }
      return { exitCode: pass ? 0 : 1, results };
    } finally {
      await admin?.end({ timeout: 5 }).catch(() => {});
      await lock.release();
    }
  } finally {
    await cp.end({ timeout: 5 }).catch(() => {});
  }

  // ---- one target (§6.7 step 6, §7.2) -----------------------------------------------------------------------------
  async function testOne(t: Target, rtAdmin: Sql, runSignal: AbortSignal): Promise<ResultRow> {
    const started = Date.now();
    const base = { ...t, backupId: null as string | null, s3Key: null as string | null, backupStartedAt: null as Date | null };
    const done = (result: string, detail: string | null = null): ResultRow => ({ ...base, result, detail, durationMs: Date.now() - started });
    const ac = new AbortController();
    const onRun = () => ac.abort(runSignal.reason === 'stopped' ? 'stopped' : 'deadline');
    runSignal.addEventListener('abort', onRun, { once: true });
    const deadline = setTimeout(() => ac.abort('deadline'), cfg.targetDeadlineMs);
    const id = t.tenantId ?? CONTROL_PLANE_ID;
    let dbName: string | null = null;
    let db: Sql | null = null;
    let note: string | null = null;
    try {
      // 6.1 pick the backup by listing.
      let picked: { key: string; row: { id: string; sha256: string; rowCounts: Record<string, unknown>; startedAt: Date } };
      try {
        const listed = await deps.reader.list(targetPrefix(cpId, t.target, id));
        const keys = new Set(listed.map((o) => o.key));
        const cutoff = now().getTime() - cfg.minObjectAgeMs;
        const candidates = listed
          .filter((o) => o.key.endsWith(DUMP_SUFFIX) && keys.has(sidecarKeyFor(o.key)) && o.lastModified.getTime() <= cutoff)
          .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
        if (candidates.length === 0) return done('FAIL:list');
        let skipped = 0;
        let found: typeof picked | null = null;
        for (const c of candidates) {
          const [row] = await cp<Array<{ id: string; sha256: string; rowCounts: Record<string, unknown>; startedAt: Date; status: string }>>`
            SELECT id::text AS id, sha256, row_counts AS "rowCounts", started_at AS "startedAt", status FROM database_backups WHERE s3_key = ${c.key}`;
          if (row && row.status === 'ok') { found = { key: c.key, row }; break; }
          skipped++;
        }
        if (!found) return done('FAIL:no-row');
        if (skipped > 0) note = `${skipped} newer object(s) skipped: no ok row`;
        picked = found;
      } catch (e) {
        return done('FAIL:list', summaryOf('list', e));
      }
      base.backupId = picked.row.id;
      base.s3Key = picked.key;
      base.backupStartedAt = picked.row.startedAt;

      // 6.2 create.
      dbName = rtDatabaseName(now());
      try {
        await (deps.hooks?.createDb ?? ((n: string) => createRtDatabase(rtAdmin, n)))(dbName);
        deps.hooks?.onCreated?.(dbName);
      } catch (e) {
        dbName = null;
        return done('FAIL:create-db', summaryOf('create-db', e));
      }

      // 6.3 stream → hash → decrypt → header check → pg_restore.
      const dbUrl = withDatabase(deps.restoreTestUrl, dbName);
      const child = childConnection(dbUrl);
      try {
        await restoreObject({
          reader: deps.reader, key: picked.key, factory: deps.keyring, spawn, bin: deps.pgRestoreBin,
          args: ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${child.url}`],
          env: childEnv(child.password),
          expectedContext: encryptionContext({ cp: cpId, kind: 'dump', target: t.target, id, key: baseKey(picked.key) }),
          expectedSha256: picked.row.sha256, signal: ac.signal,
        });
      } catch (e) {
        const stage = e instanceof StageError ? e.stage : 'pg_restore';
        return done(`FAIL:${stage}`, summaryOf(stage, e));
      }

      // 6.4 the sidecar.
      try {
        const sidecar = await streamToBuffer(await deps.reader.get(sidecarKeyFor(picked.key)));
        const manifest = JSON.parse((await decryptBuffer(deps.keyring, sidecar,
          encryptionContext({ cp: cpId, kind: 'manifest', target: t.target, id, key: baseKey(picked.key) }))).toString('utf8')) as { sha256?: string; rowCounts?: Record<string, unknown> };
        if (manifest.sha256 !== picked.row.sha256 || !compareCounts(picked.row.rowCounts ?? {}, manifest.rowCounts ?? {}).equal) {
          return done('FAIL:sidecar', 'sidecar differs from the row');
        }
      } catch (e) {
        return done('FAIL:sidecar', summaryOf('sidecar', e));
      }
      if (ac.signal.aborted) return done(`FAIL:${String(ac.signal.reason)}`);

      // 6.5 the counts.
      try {
        db = postgres(clientUrl(dbUrl), { max: 1, connect_timeout: 30, onnotice: () => {} });
        const restored = await countTables(db);
        const cmp = compareCounts(picked.row.rowCounts ?? {}, restored);
        if (ac.signal.aborted) return done(`FAIL:${String(ac.signal.reason)}`);
        return cmp.equal ? done('PASS', note) : done('MISMATCH', describeDiffs(cmp.diffs).slice(0, 2000));
      } catch (e) {
        return done(ac.signal.aborted ? `FAIL:${String(ac.signal.reason)}` : 'FAIL:count', summaryOf('count', e));
      }
    } finally {
      clearTimeout(deadline);
      runSignal.removeEventListener('abort', onRun);
      // 6.6 always: close own sessions, drop (plain, then FORCE only if a session remains).
      await db?.end({ timeout: 5 }).catch(() => {});
      if (dbName) {
        try {
          const gone = await (deps.hooks?.dropDb ?? ((n: string) => dropRtDatabase(rtAdmin, n)))(dbName);
          if (!gone) log(`${t.slug}: the test database could not be dropped; the next audit or test drops it`);
        } catch (e) {
          log(`${t.slug}: the test database could not be dropped (${summaryOf('drop', e)}); the next audit or test drops it`);
        }
      }
    }
  }
}

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

/**
 * Eligible workspaces (§6.7 step 5): active / suspended / provisioning with a URL and an `ok` backup in the last 36 h.
 * Due date: the latest PASS's tested_at, else the first ok backup's finished_at.
 */
export async function eligibleWorkspaces(cp: Sql, now: Date): Promise<EligibleWorkspace[]> {
  const since = new Date(now.getTime() - 36 * HOUR);
  const rows = await cp<Array<{ tenantId: string; slug: string; lastPass: Date | null; firstOk: Date }>>`
    SELECT t.id::text AS "tenantId", t.slug,
      (SELECT max(r.tested_at) FROM restore_test_results r WHERE r.tenant_id = t.id AND r.result = 'PASS') AS "lastPass",
      (SELECT min(b.finished_at) FROM database_backups b WHERE b.tenant_id = t.id AND b.status = 'ok') AS "firstOk"
    FROM tenants t
    WHERE t.status IN ('active', 'suspended', 'provisioning') AND t.db_url_encrypted IS NOT NULL
      AND EXISTS (SELECT 1 FROM database_backups b WHERE b.tenant_id = t.id AND b.status = 'ok' AND b.finished_at >= ${since})`;
  return rows.map((r) => ({ tenantId: r.tenantId, slug: r.slug, dueAt: r.lastPass ?? r.firstOk }));
}

export { SIDECAR_SUFFIX };
