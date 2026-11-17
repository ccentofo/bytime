/**
 * The `backup` command (feature-plan-database-backups.md §6.4, v4.1 §6.2; state table §7.1).
 *
 * Order (a barrier): every tenant target (provisioning / active / suspended with a URL, by slug) at BACKUP_CONCURRENCY,
 * one retry round for failed tenants (new keys), then the control plane: when every tenant has settled, or at T + 75 min
 * at the latest, outside the tenant pool, so the control-plane dump holds this run's tenant rows. One control-plane retry
 * if ≥ 35 min remain before the 6 h run deadline.
 *
 * Per target: a direct connection; Postgres 16 check; a REPEATABLE READ READ ONLY transaction exports a snapshot and
 * counts every table exactly; pg_dump --snapshot streams through the encrypt stream and the end gate (dump-pipeline.ts)
 * into the store; then the encrypted sidecar; the `BACKUP` line; the row. A 30-minute deadline per target.
 *
 * One run at a time (BACKUP_LOCK_KEY on the direct host, held for the run); each target first defers while a migration
 * holds MIGRATE_RUN_LOCK_KEY. On lock loss the run re-takes the lock and aborts in-flight dumps if a migration started in
 * the gap; if it can't re-take it, it starts no new targets and aborts in-flight dumps (`lock-lost`).
 */
import postgres from 'postgres';
import { BACKUP_LOCK_KEY, MIGRATE_RUN_LOCK_KEY } from '../../src/lib/tenant/backup-locks';
import { toDirectConnectionUrl } from '../../src/lib/tenant/direct-url';
import { decrypt } from '../../src/lib/encryption';
import { CONTROL_PLANE_ID, controlPlaneId, dumpKey, baseKey, sidecarKeyFor, type BackupTarget } from './lib/keys';
import { encryptBuffer, encryptionContext, makeEncryptStream, type HeaderInfo, type KeyringFactory } from './lib/crypto';
import type { BackupStore } from './lib/store';
import { runDumpPipeline } from './lib/dump-pipeline';
import { childConnection, childEnv, clientUrl } from './lib/pg-url';
import { regionOfUrl } from './lib/neon-host';
import { countTables, type RowCounts } from './lib/counts';
import { realSpawn, type SpawnFn } from './lib/child';
import { StageError, summaryOf } from './lib/summarize-error';
import { acquireLock, probeClient, retakeLock, type Connect, type HeldLock, type LockTiming } from './lib/locks';
import { isAdvisoryLockHeld } from './lib/backup-wait';
import { assertBackupTables, controlPlaneClient, insertBackupRow, insertPermissionCheck, listTenantTargets, tenantStatus, type Sql } from './lib/sql';
import { backupProbes, probesOk, type KeyProbeClient, type StoredEdk } from './lib/probes';
import { FatalError } from './lib/env';
import { deferred, HOUR, MINUTE, runPool, utcDayStart } from './lib/util';

export interface TargetRef {
  target: BackupTarget;
  tenantId: string | null;
  slug: string;
  url: string;
}

export interface TargetOutcome {
  target: BackupTarget;
  tenantId: string | null;
  slug: string;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
  key?: string;
  /** `failed` with a reason that the retry round must not retry. */
  final?: boolean;
}

export interface BackupOptions {
  ifMissingToday?: boolean;
  only?: string;
  dryRun?: boolean;
  /** Tests: limit the tenant targets; `controlPlane: false` skips the control plane. */
  filter?: { tenantIds?: string[]; controlPlane?: boolean };
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type DbConnect = (url: string, options: postgres.Options<{}>) => postgres.Sql;

export interface BackupDeps {
  controlPlaneUrl: string;
  store: BackupStore;
  keyring: KeyringFactory;
  /** When set, the permission probes run at the end (§6.13). Production always sets it. */
  keyClient?: KeyProbeClient;
  pgDumpBin: string;
  pgDumpVersion: string;
  runId: string;
  log: (line: string) => void;
  options?: BackupOptions;
  spawn?: SpawnFn;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  decryptUrl?: (encrypted: string) => string;
  concurrency?: number;
  targetDeadlineMs?: number;
  runDeadlineMs?: number;
  controlPlaneBarrierMs?: number;
  controlPlaneRetryMinLeftMs?: number;
  connectRetryDelayMs?: number;
  migrationPollMs?: number;
  lockTiming?: LockTiming;
  lockConnect?: Connect;
  /** Seam: the client factory for target databases (connection-error tests). */
  connectTarget?: DbConnect;
  /** Seam: an ECS stop (SIGTERM) or a test's stop. */
  stopSignal?: AbortSignal;
  hooks?: {
    beforeCounts?: (t: TargetRef) => Promise<void>;
    /** S6: between the counts and the pg_dump spawn (rows inserted here must not reach the dump). */
    afterCounts?: (t: TargetRef) => Promise<void>;
    /** Tests: replace the pg_dump command per target (fake dumps). */
    dumpCommand?: (t: TargetRef, args: string[]) => { bin: string; args: string[] };
    /** Tests: the row insert (S5). */
    insertRow?: typeof insertBackupRow;
  };
}

export const DEFAULTS = {
  concurrency: 3,
  targetDeadlineMs: 30 * MINUTE,
  runDeadlineMs: 6 * HOUR,
  controlPlaneBarrierMs: 75 * MINUTE,
  controlPlaneRetryMinLeftMs: 35 * MINUTE,
  connectRetryDelayMs: 5_000,
  migrationPollMs: MINUTE,
};

/** Reasons the retry round never retries (they say nothing about the target itself). */
const NO_RETRY = new Set(['lock-lost', 'run-deadline', 'stopped', 'migration-running']);

const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

export async function runBackup(deps: BackupDeps): Promise<{ exitCode: number; outcomes: TargetOutcome[] }> {
  const opts = deps.options ?? {};
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? abortableSleep;
  const decryptUrl = deps.decryptUrl ?? decrypt;
  const spawn = deps.spawn ?? realSpawn;
  const connectTarget: DbConnect = deps.connectTarget ?? ((u, o) => postgres(u, o));
  const cfg = {
    concurrency: deps.concurrency ?? DEFAULTS.concurrency,
    targetDeadlineMs: deps.targetDeadlineMs ?? DEFAULTS.targetDeadlineMs,
    runDeadlineMs: deps.runDeadlineMs ?? DEFAULTS.runDeadlineMs,
    barrierMs: deps.controlPlaneBarrierMs ?? DEFAULTS.controlPlaneBarrierMs,
    cpRetryMinLeftMs: deps.controlPlaneRetryMinLeftMs ?? DEFAULTS.controlPlaneRetryMinLeftMs,
    connectRetryDelayMs: deps.connectRetryDelayMs ?? DEFAULTS.connectRetryDelayMs,
    migrationPollMs: deps.migrationPollMs ?? DEFAULTS.migrationPollMs,
  };
  const log = deps.log;
  const cpUrl = deps.controlPlaneUrl;
  const cpId = controlPlaneId(cpUrl);
  const cp = controlPlaneClient(cpUrl);

  try {
    if (!opts.dryRun) await assertBackupTables(cp);

    // ---- targets -------------------------------------------------------------------------------------------------
    let tenants = await listTenantTargets(cp);
    if (opts.filter?.tenantIds) tenants = tenants.filter((t) => opts.filter!.tenantIds!.includes(t.id));
    let includeCp = opts.filter?.controlPlane !== false;
    if (opts.only) {
      if (opts.only === 'control-plane') {
        tenants = [];
      } else {
        tenants = tenants.filter((t) => t.slug === opts.only);
        if (tenants.length === 0) throw new FatalError(`--only: no tenant "${opts.only}" to back up`);
        includeCp = false;
      }
    }

    if (opts.dryRun) {
      return await dryRun(tenants, includeCp);
    }

    const lock = await acquireLock(cpUrl, BACKUP_LOCK_KEY, { timing: deps.lockTiming, connect: deps.lockConnect });
    if (!lock) {
      log('another backup run is active; exiting');
      return { exitCode: 0, outcomes: [] };
    }

    const probe = probeClient(cpUrl, deps.lockConnect);
    let currentLock: HeldLock = lock;
    let noNewTargets = false;
    const inFlight = new Set<AbortController>();
    const abortInFlight = (reason: string) => { for (const ac of inFlight) ac.abort(reason); };
    let lostHandling: Promise<void> = Promise.resolve();
    const runAbort = new AbortController();
    const runStart = now();
    const runDeadlineAt = runStart.getTime() + cfg.runDeadlineMs;
    const runTimer = setTimeout(() => runAbort.abort('run-deadline'), cfg.runDeadlineMs);
    const onStop = () => runAbort.abort('stopped');
    deps.stopSignal?.addEventListener('abort', onStop, { once: true });
    if (deps.stopSignal?.aborted) onStop();

    const onLockLost = () => {
      lostHandling = (async () => {
        log('backup run lock lost; re-taking it');
        const re = runAbort.signal.aborted ? null
          : await retakeLock(cpUrl, BACKUP_LOCK_KEY, { timing: deps.lockTiming, connect: deps.lockConnect, delayMs: 1_000 });
        if (re) {
          currentLock = re;
          re.onLost(onLockLost);
          const migrating = await isAdvisoryLockHeld(probe, MIGRATE_RUN_LOCK_KEY).catch(() => true);
          if (migrating) {
            log('a migration started while the lock was lost; aborting in-flight dumps');
            abortInFlight('lock-lost');
          }
        } else {
          log('the backup run lock could not be re-taken; starting no new targets');
          noNewTargets = true;
          abortInFlight('lock-lost');
        }
      })();
    };
    lock.onLost(onLockLost);

    let firstEdk: StoredEdk | null = null;
    let writtenKey: string | null = null;
    const outcomes: TargetOutcome[] = [];

    try {
      // ---- the catch-up -----------------------------------------------------------------------------------------
      if (opts.ifMissingToday) {
        const dayStart = utcDayStart(now());
        const [cpToday] = await cp<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM database_backups
          WHERE target = 'control-plane' AND status = 'ok' AND finished_at >= ${dayStart}) AS ok`;
        if (cpToday.ok) {
          const latest = await cp<{ tenantId: string; status: string }[]>`SELECT DISTINCT ON (tenant_id) tenant_id::text AS "tenantId", status
            FROM database_backups WHERE target = 'tenant' AND finished_at >= ${dayStart} ORDER BY tenant_id, finished_at DESC`;
          const okToday = new Set(latest.filter((r) => r.status === 'ok').map((r) => r.tenantId));
          tenants = tenants.filter((t) => !okToday.has(t.id));
          includeCp = false;
          if (tenants.length === 0) {
            log('catch-up: today is complete; nothing to do');
            return { exitCode: 0, outcomes };
          }
          log(`catch-up: ${tenants.length} workspace(s) failed or have no backup today`);
        } else {
          log('catch-up: no control-plane backup today; running a full backup');
        }
      }

      // ---- one target ---------------------------------------------------------------------------------------------
      const record = (o: TargetOutcome) => { outcomes.push(o); return o; };

      const backupTarget = async (ref: TargetRef): Promise<TargetOutcome> => {
        const startedAt = now();
        const ac = new AbortController();
        inFlight.add(ac);
        const onRunAbort = () => ac.abort(runAbort.signal.reason);
        runAbort.signal.addEventListener('abort', onRunAbort, { once: true });
        if (runAbort.signal.aborted) onRunAbort();
        const deadline = setTimeout(() => ac.abort('deadline'), cfg.targetDeadlineMs);
        const direct = toDirectConnectionUrl(ref.url);
        const region = regionOfUrl(direct);
        const id = ref.tenantId ?? CONTROL_PLANE_ID;
        let serverVersion: string | null = null;
        let rowCounts: RowCounts | null = null;
        const insertRow = deps.hooks?.insertRow ?? insertBackupRow;
        try {
          let dump: { key: string; sha256: string; bytes: number };
          const once = () => dumpOnce(ref, direct, ac.signal, (v, c) => { serverVersion = v; rowCounts = c; });
          try {
            dump = await once();
          } catch (e) {
            if (e instanceof StageError && e.stage === 'connect' && !ac.signal.aborted) {
              log(`${ref.slug}: connection error; retrying in ${Math.round(cfg.connectRetryDelayMs / 1000)}s`);
              await sleep(cfg.connectRetryDelayMs, ac.signal);
              if (ac.signal.aborted) throw new StageError(String(ac.signal.reason));
              dump = await once();
            } else {
              throw e;
            }
          }
          // Sidecar.
          const finishedAt = now();
          const manifest = {
            v: 1, target: ref.target, tenantId: ref.tenantId, slug: ref.slug, runId: deps.runId, key: dump.key,
            bytes: dump.bytes, sha256: dump.sha256, rowCounts, serverVersion, pgDumpVersion: deps.pgDumpVersion,
            startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
          };
          try {
            const ctx = encryptionContext({ cp: cpId, kind: 'manifest', target: ref.target, id, key: baseKey(dump.key) });
            const { ciphertext } = await encryptBuffer(deps.keyring, ctx, Buffer.from(JSON.stringify(manifest)));
            await deps.store.putSmall(sidecarKeyFor(dump.key), ciphertext);
          } catch (e) {
            throw new StageError('sidecar', e);
          }
          if (ac.signal.aborted) throw new StageError(String(ac.signal.reason));
          writtenKey ??= dump.key;
          const line = `BACKUP ${cpId} ${ref.target} ${id} ${ref.slug} ${deps.runId} ${dump.key} ${dump.sha256} ${dump.bytes}`;
          log(line);
          try {
            await insertRow(cp, {
              tenantId: ref.tenantId, target: ref.target, runId: deps.runId, status: 'ok', s3Key: dump.key, bytes: dump.bytes,
              sha256: dump.sha256, rowCounts, serverVersion, pgDumpVersion: deps.pgDumpVersion, region,
              targetDeadlineMs: cfg.targetDeadlineMs, error: null, startedAt, finishedAt,
            });
          } catch (e) {
            log(`${line} row-failed`);
            log(`${ref.slug}: ${summaryOf('row', e)}`);
            return record({ target: ref.target, tenantId: ref.tenantId, slug: ref.slug, status: 'failed', error: summaryOf('row', e), key: dump.key, final: true });
          }
          return record({ target: ref.target, tenantId: ref.tenantId, slug: ref.slug, status: 'ok', key: dump.key });
        } catch (e) {
          const summary = summaryOf('backup', e);
          const stage = e instanceof StageError ? e.stage : 'backup';
          log(`${ref.slug}: failed: ${summary}`);
          try {
            await insertRow(cp, {
              tenantId: ref.tenantId, target: ref.target, runId: deps.runId, status: 'failed', s3Key: null, bytes: null,
              sha256: null, rowCounts, serverVersion, pgDumpVersion: deps.pgDumpVersion, region,
              targetDeadlineMs: cfg.targetDeadlineMs, error: summary, startedAt, finishedAt: now(),
            });
          } catch (re) {
            log(`${ref.slug}: the failed row could not be recorded: ${summaryOf('row', re)}`);
          }
          return record({ target: ref.target, tenantId: ref.tenantId, slug: ref.slug, status: 'failed', error: summary, final: NO_RETRY.has(stage) });
        } finally {
          clearTimeout(deadline);
          runAbort.signal.removeEventListener('abort', onRunAbort);
          inFlight.delete(ac);
        }
      };

      /** Connect, check, snapshot + counts, then the pipeline (v4.1 §6.2 step 2). */
      const dumpOnce = async (ref: TargetRef, direct: string, signal: AbortSignal, seen: (v: string, c: RowCounts | null) => void) => {
        if (signal.aborted) throw new StageError(String(signal.reason));
        const sql = connectTarget(clientUrl(direct), { max: 1, connect_timeout: 30, max_lifetime: null, idle_timeout: null as unknown as undefined, onnotice: () => {} });
        const pipelineDone = deferred<{ key: string; sha256: string; bytes: number }>();
        const onAbort = () => {
          pipelineDone.reject(new StageError(String(signal.reason)));
          void sql.end({ timeout: 5 }).catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          let v: { num: number; ver: string };
          try {
            [v] = await sql<{ num: number; ver: string }[]>`SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS ver`;
          } catch (e) {
            if (signal.aborted) throw new StageError(String(signal.reason));
            throw new StageError('connect', e);
          }
          if (!(v.num >= 160000 && v.num <= 169999)) throw new StageError('server-version', new Error('server version'));
          seen(v.ver, null);
          let pipelineStarted = false;
          const key = dumpKey({ cp: cpId, target: ref.target, id: ref.tenantId ?? CONTROL_PLANE_ID, now: now(), runId: deps.runId });
          const begin = sql.begin('isolation level repeatable read read only', async (tx) => {
            await tx`SET LOCAL idle_in_transaction_session_timeout = 0`;
            await tx`SET LOCAL statement_timeout = 0`;
            await tx`SET LOCAL lock_timeout = '60s'`;
            const [{ snap }] = await tx<{ snap: string }[]>`SELECT pg_export_snapshot() AS snap`;
            await deps.hooks?.beforeCounts?.(ref);
            const counts = await countTables(tx as unknown as Parameters<typeof countTables>[0]);
            seen(v.ver, counts);
            await deps.hooks?.afterCounts?.(ref);
            pipelineStarted = true;
            const child = childConnection(direct);
            const realArgs = ['-Fc', '--no-owner', '--no-acl', '--lock-wait-timeout=60s', `--snapshot=${snap}`, `--dbname=${child.url}`];
            const cmd = deps.hooks?.dumpCommand?.(ref, realArgs) ?? { bin: deps.pgDumpBin, args: realArgs };
            const ctx = encryptionContext({ cp: cpId, kind: 'dump', target: ref.target, id: ref.tenantId ?? CONTROL_PLANE_ID, key: baseKey(key) });
            Promise.resolve()
              .then(() => runDumpPipeline({
                spawn, bin: cmd.bin, args: cmd.args, env: childEnv(child.password), makeEncrypt: () => makeEncryptStream(deps.keyring, ctx),
                store: deps.store, key, signal,
                onHeader: (h: HeaderInfo) => {
                  const edk = h.encryptedDataKeys[0];
                  if (!firstEdk && edk) firstEdk = { edk: Buffer.from(edk.encryptedDataKey).toString('base64'), context: { ...h.encryptionContext } };
                },
              }))
              .then((r) => pipelineDone.resolve({ key, ...r }), pipelineDone.reject);
            await pipelineDone.promise.catch(() => {});
          });
          begin.catch((e) => { if (!pipelineStarted) pipelineDone.reject(e instanceof StageError ? e : new StageError('snapshot', e)); });
          return await pipelineDone.promise;
        } finally {
          signal.removeEventListener('abort', onAbort);
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      };

      // True while a target is deferring for a running migration: targets the run deadline then cuts are recorded
      // `migration-running`, not `run-deadline` (§6.4: "Targets not reached are recorded failed (migration-running)").
      let migrationBlocking = false;
      const stopReason = () => {
        const r = String(runAbort.signal.reason);
        return r === 'run-deadline' && migrationBlocking ? 'migration-running' : r;
      };
      const waitForMigration = async (slug: string): Promise<void> => {
        let waited = 0;
        for (;;) {
          if (runAbort.signal.aborted) return;
          let held: boolean;
          try {
            held = await isAdvisoryLockHeld(probe, MIGRATE_RUN_LOCK_KEY);
          } catch {
            held = true; // can't tell: wait (fail towards not overlapping a migration)
          }
          if (!held) {
            migrationBlocking = false;
            if (waited > 0) log(`${slug}: waited ${Math.round(waited / 1000)}s for a migration to finish`);
            return;
          }
          migrationBlocking = true;
          if (waited === 0) log(`${slug}: a migration is running; deferring`);
          await sleep(cfg.migrationPollMs, runAbort.signal);
          waited += cfg.migrationPollMs;
        }
      };

      const notReached = (ref: Omit<TargetRef, 'url'>, reason: string) => {
        const startedAt = now();
        log(`${ref.slug}: not started: ${reason}`);
        return insertBackupRow(cp, {
          tenantId: ref.tenantId, target: ref.target, runId: deps.runId, status: 'failed', s3Key: null, bytes: null, sha256: null,
          rowCounts: null, serverVersion: null, pgDumpVersion: deps.pgDumpVersion, region: null, targetDeadlineMs: cfg.targetDeadlineMs,
          error: reason, startedAt, finishedAt: startedAt,
        }).catch((e) => log(`${ref.slug}: the failed row could not be recorded: ${summaryOf('row', e)}`))
          .then(() => record({ ...ref, status: 'failed', error: reason, final: true }));
      };

      const runTenant = async (t: { id: string; slug: string; dbUrlEncrypted: string }): Promise<TargetOutcome> => {
        const ref0 = { target: 'tenant' as const, tenantId: t.id, slug: t.slug };
        if (runAbort.signal.aborted) return notReached(ref0, stopReason());
        if (noNewTargets) return notReached(ref0, 'lock-lost');
        await waitForMigration(t.slug);
        if (runAbort.signal.aborted) return notReached(ref0, stopReason());
        if (noNewTargets) return notReached(ref0, 'lock-lost');
        const status = await tenantStatus(cp, t.id);
        if (status === 'deleting' || status === 'deleted' || status === null) {
          log(`${t.slug}: skipped (${status ?? 'gone'})`);
          return record({ ...ref0, status: 'skipped' });
        }
        let url: string;
        try {
          url = decryptUrl(t.dbUrlEncrypted);
        } catch (e) {
          const summary = summaryOf('decrypt-url', e);
          await insertBackupRow(cp, {
            tenantId: t.id, target: 'tenant', runId: deps.runId, status: 'failed', s3Key: null, bytes: null, sha256: null, rowCounts: null,
            serverVersion: null, pgDumpVersion: deps.pgDumpVersion, region: null, targetDeadlineMs: cfg.targetDeadlineMs, error: summary,
            startedAt: now(), finishedAt: now(),
          }).catch(() => {});
          log(`${t.slug}: failed: ${summary}`);
          return record({ ...ref0, status: 'failed', error: summary });
        }
        return backupTarget({ ...ref0, url });
      };

      const runControlPlane = async (): Promise<void> => {
        const ref = { target: 'control-plane' as const, tenantId: null, slug: CONTROL_PLANE_ID, url: cpUrl };
        const go = async (): Promise<TargetOutcome> => {
          if (runAbort.signal.aborted) return notReached(ref, stopReason());
          if (noNewTargets) return notReached(ref, 'lock-lost');
          await waitForMigration(ref.slug);
          if (runAbort.signal.aborted) return notReached(ref, stopReason());
          if (noNewTargets) return notReached(ref, 'lock-lost');
          return backupTarget(ref);
        };
        const first = await go();
        if (first.status === 'failed' && !first.final && runDeadlineAt - now().getTime() >= cfg.cpRetryMinLeftMs) {
          log('control plane failed; one retry');
          await go();
        }
      };

      // ---- the barrier -------------------------------------------------------------------------------------------
      const running = new Set<string>();
      let cpPromise: Promise<void> | null = null;
      const startCp = () => {
        if (!includeCp || cpPromise) return;
        if (running.size > 0) log(`control plane started before ${[...running].sort().join(', ')} finished`);
        cpPromise = runControlPlane();
      };
      const barrier = setTimeout(startCp, Math.max(0, runStart.getTime() + cfg.barrierMs - now().getTime()));
      try {
        const tracked = async (t: (typeof tenants)[number]) => {
          running.add(t.slug);
          try { return await runTenant(t); } finally { running.delete(t.slug); }
        };
        const firstRound: TargetOutcome[] = [];
        await runPool(tenants, cfg.concurrency, async (t) => { firstRound.push(await tracked(t)); });
        const retry = tenants.filter((t) => firstRound.some((o) => o.tenantId === t.id && o.status === 'failed' && !o.final));
        if (retry.length > 0 && !runAbort.signal.aborted && !noNewTargets) {
          log(`retry round: ${retry.map((t) => t.slug).join(', ')}`);
          await runPool(retry, cfg.concurrency, async (t) => { await tracked(t); });
        }
        startCp();
        await cpPromise;
      } finally {
        clearTimeout(barrier);
      }
      await lostHandling;

      // ---- probes (§6.13) ----------------------------------------------------------------------------------------
      if (deps.keyClient) {
        try {
          const detail = await backupProbes(deps.store, deps.keyClient, { runId: deps.runId, writtenKey, edk: firstEdk });
          await insertPermissionCheck(cp, { runId: deps.runId, role: 'backup', checkedAt: now(), ok: probesOk(detail), detail });
        } catch (e) {
          log(`permission probes failed: ${summaryOf('probes', e)}`);
        }
      }
    } finally {
      clearTimeout(runTimer);
      deps.stopSignal?.removeEventListener('abort', onStop);
      await lostHandling.catch(() => {});
      await currentLock.release();
      await probe.end({ timeout: 5 }).catch(() => {});
    }

    // ---- summary ---------------------------------------------------------------------------------------------------
    const latest = new Map<string, TargetOutcome>();
    for (const o of outcomes) latest.set(o.tenantId ?? CONTROL_PLANE_ID, o);
    for (const o of latest.values()) log(`  ${o.slug.padEnd(24)} ${o.status}${o.error ? `: ${o.error}` : ''}`);
    const failed = [...latest.values()].filter((o) => o.status === 'failed');
    return { exitCode: failed.length > 0 ? 1 : 0, outcomes };
  } finally {
    await cp.end({ timeout: 5 }).catch(() => {});
  }

  async function dryRun(tenants: Array<{ id: string; slug: string; dbUrlEncrypted: string }>, withCp: boolean) {
    const targets: TargetRef[] = [];
    for (const t of tenants) {
      try {
        targets.push({ target: 'tenant', tenantId: t.id, slug: t.slug, url: decryptUrl(t.dbUrlEncrypted) });
      } catch (e) {
        log(`${t.slug}: ${summaryOf('decrypt-url', e)}`);
      }
    }
    if (withCp) targets.push({ target: 'control-plane', tenantId: null, slug: CONTROL_PLANE_ID, url: cpUrl });
    log(`dry run: ${targets.length} target(s)`);
    for (const t of targets) {
      const sql = connectTarget(clientUrl(toDirectConnectionUrl(t.url)), { max: 1, connect_timeout: 15, onnotice: () => {} });
      try {
        const [v] = await sql<{ ver: string }[]>`SELECT current_setting('server_version') AS ver`;
        log(`  ${t.slug.padEnd(24)} server ${v.ver} region ${regionOfUrl(toDirectConnectionUrl(t.url))}`);
      } catch (e) {
        log(`  ${t.slug.padEnd(24)} ${summaryOf('connect', e)}`);
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    }
    return { exitCode: 0, outcomes: [] as TargetOutcome[] };
  }
}

export type { Sql };
