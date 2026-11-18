/**
 * The run logic of scripts/migrate-all.ts, with seams (feature-plan-database-backups.md §6.4 "Migrations and backups
 * never overlap"; impact analysis G3). The CLI (argument parsing, banner, dotenv, exit) stays in scripts/migrate-all.ts.
 *
 * Normal mode adds the backup handshake:
 *  0. If nothing is pending (the control plane and every tenant count 0, the existing --check logic), skip it: an
 *     app-only deploy never waits for a backup. Any count that ERRORS means the handshake runs (fail towards waiting).
 *  1. Take MIGRATE_RUN_LOCK_KEY (blocking if another migrate-all holds it), on the control plane's direct host.
 *  2. Read through pg_locks whether BACKUP_LOCK_KEY is held (never by taking it).
 *  3. If a backup is running: release, print "Waiting for the backup run to finish…", poll every 60 s for up to 30 min,
 *     then retry from 1; past the limit exit 1 with nothing changed.
 *  4. Otherwise migrate under the lock. If the lock is found lost (heartbeat), stop before the next database: exit 1.
 * --check never takes or waits for a lock.
 *
 * The disaster deploy path (feature-plan-disaster-restore.md §6.0), when `deps.disaster` is given:
 *  - `--skip-lost` skips a tenant whose pendingCount throws (any error) and whose newest decisive proof is live
 *    (disaster-proofs.ts). Step 0 doesn't count it as pending. A normal run appends a `skip` row per skip (a failed insert
 *    → FAILED); `--check` is read-only (approved detail D1). Skipped rows print the tenant's uuid, never its slug.
 *  - A tenant step 0 excluded that connects in the pass, in a run that doesn't hold the migrate lock, is FAILED
 *    "reachable again; re-run the deploy" (uuid), so it is never migrated without the lock.
 *  - Every normal run (with or without the flag) appends, for each tenant migrated or up to date: a `reachable-again`
 *    proof when it has a live proof (a failed insert → FAILED, D2), and a `migrated` skip-kind row when its newest
 *    `skipped` or `linked` row is newer than its newest `migrated` (a failed insert → a warning only, D2).
 *  - Reading the facts tolerates a missing `disaster_actions` table (42P01 → no facts): the deploy that merges this item
 *    runs before the migration creating it.
 */
import { BACKUP_LOCK_KEY, MIGRATE_RUN_LOCK_KEY } from '../../src/lib/tenant/backup-locks';
import { acquireLock, probeClient, type Connect, type HeldLock, type LockTiming } from '../backup/lib/locks';
import { isAdvisoryLockHeld, waitForLock } from '../backup/lib/backup-wait';
import { MIGRATABLE_TENANT_STATUSES, migrateOneTenant, type TenantMigrationDeps, type TenantOutcome, type TenantToMigrate } from './tenant-migration';
import { hasLiveProof, needsMigratedRow, NO_FACTS, RECONNECTED_DETAIL, SKIPPED_DETAIL, type TenantDisasterFacts } from '../backup/lib/disaster-proofs';

export interface MigrateAllOptions {
  check: boolean;
  concurrency: number;
  onlySlug?: string;
  /** feature-plan-disaster-restore.md §6.0: skip tenants proven lost by the disaster button. */
  skipLost?: boolean;
}

export interface MigrateTenantRow {
  id: string;
  slug: string;
  status: string;
  dbUrlEncrypted: string | null;
  neonProjectId: string | null;
}

export interface MigrateAllDeps {
  controlUrl: string;
  log: (line: string) => void;
  error: (line: string) => void;
  redact: (message: string) => string;
  controlPending: () => Promise<number>;
  migrateControl: () => Promise<void>;
  listTenants: () => Promise<MigrateTenantRow[]>;
  decryptUrl: (encrypted: string) => string;
  tenant: TenantMigrationDeps;
  /** The disaster deploy path's control-plane reads and writes (§6.0). Absent: no proofs, nothing recorded. */
  disaster?: DisasterDeployDeps;
  lock?: {
    connect?: Connect;
    timing?: LockTiming;
    waitMaxMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
}

export interface DisasterActionInput {
  tenantId: string;
  kind: 'proof' | 'skip';
  status: 'reachable-again' | 'skipped' | 'migrated';
  oldProjectId: string | null;
}

export interface DisasterDeployDeps {
  /** `migrate-<timestamp>`: the run id on every row this run appends. */
  runId: string;
  /** Per tenant id. Throws on a read error; a missing table (42P01) must come back as an empty map. */
  readFacts(): Promise<Map<string, TenantDisasterFacts>>;
  append(row: DisasterActionInput): Promise<void>;
}

/** `label` is what the table prints: the slug, or the uuid for the disaster rows (the deploy log is public). */
type TenantResult = { label: string; status: string; outcome: TenantOutcome; detail: string; durationMs: number };

export const BACKUP_WAIT_MAX_MS = 30 * 60_000;

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function printTable(log: (l: string) => void, rows: TenantResult[]) {
  const header = ['slug', 'status', 'result', 'duration'];
  const widths = [
    Math.max(header[0].length, ...rows.map((r) => r.label.length)),
    Math.max(header[1].length, ...rows.map((r) => r.status.length)),
    Math.max(header[2].length, ...rows.map((r) => `${r.outcome}${r.detail ? `: ${r.detail}` : ''}`.length)),
    Math.max(header[3].length, ...rows.map((r) => `${r.durationMs}ms`.length)),
  ];
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  |  ');
  log('\n' + line(header));
  log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) log(line([r.label, r.status, `${r.outcome}${r.detail ? `: ${r.detail}` : ''}`, `${r.durationMs}ms`]));
  log('');
}

/**
 * Step 0: true when anything is pending or any count can't be read (fail towards waiting). Counts run with the run's
 * concurrency and are kept in `counts` (by URL) so the migration pass reuses them instead of counting twice. A
 * `deleting` tenant whose database is CONFIRMED gone (the existing absence check) is not pending: its count can't be
 * read, and an app-only deploy must not wait on it. With `--skip-lost`, a tenant proven lost whose count fails is
 * excluded the same way (and recorded in `excluded`).
 */
async function anythingPending(deps: MigrateAllDeps, controlPending: number, rows: MigrateTenantRow[], concurrency: number, counts: Map<string, number>,
  skippable: (t: MigrateTenantRow) => boolean, excluded: Set<string>): Promise<boolean> {
  let pending = controlPending > 0;
  await runWithConcurrency(rows, concurrency, async (t) => {
    if (!t.dbUrlEncrypted) return;
    let url: string;
    try {
      url = deps.decryptUrl(t.dbUrlEncrypted);
    } catch {
      pending = true;
      return;
    }
    try {
      const n = await deps.tenant.pendingCount(url);
      counts.set(url, n);
      if (n > 0) pending = true;
    } catch {
      if (t.status === 'deleting' && (await deps.tenant.confirmedAbsent(t, url)).absent) return;
      // §6.0: a tenant proven lost (and failing to connect now) doesn't force a 30-minute backup wait.
      if (skippable(t)) {
        excluded.add(t.id);
        return;
      }
      pending = true;
    }
  });
  return pending;
}

/**
 * Steps 1–3. Returns the held MIGRATE_RUN lock, or null when a backup run outlasted the wait (nothing changed).
 */
async function takeMigrateLock(deps: MigrateAllDeps): Promise<HeldLock | null> {
  const o = deps.lock ?? {};
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxMs = o.waitMaxMs ?? BACKUP_WAIT_MAX_MS;
  const start = now();
  const probe = probeClient(deps.controlUrl, o.connect);
  try {
    for (;;) {
      const lock = await acquireLock(deps.controlUrl, MIGRATE_RUN_LOCK_KEY, { wait: true, timing: o.timing, connect: o.connect });
      if (!lock) throw new Error('MIGRATE_RUN lock not granted');
      let backupRunning: boolean;
      try {
        backupRunning = await isAdvisoryLockHeld(probe, BACKUP_LOCK_KEY);
      } catch (err) {
        await lock.release(); // never leak MIGRATE_RUN when the check fails
        throw err;
      }
      if (!backupRunning) return lock;
      await lock.release();
      const remaining = maxMs - (now() - start);
      if (remaining <= 0) return null;
      deps.log('Waiting for the backup run to finish…');
      const w = await waitForLock(probe, BACKUP_LOCK_KEY, { sleep, now, maxMs: remaining, pollMs: o.pollMs });
      if (!w.free) return null;
    }
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
}

export async function runMigrateAll(opts: MigrateAllOptions, deps: MigrateAllDeps): Promise<number> {
  const { check, concurrency, onlySlug } = opts;
  const skipLost = Boolean(opts.skipLost);
  const failed = (err: unknown) => deps.redact(String((err as Error)?.message ?? err));
  const listTenants = async (): Promise<MigrateTenantRow[] | null> => {
    try {
      return await deps.listTenants();
    } catch (err) {
      deps.error(`migrate-all failed: ${failed(err)}`);
      return null;
    }
  };

  // §6.0: the disaster facts, read once (a missing table is "no facts"; any other read error stops the run).
  let facts: Map<string, TenantDisasterFacts> | null = null;
  const loadFacts = async (): Promise<boolean> => {
    if (facts) return true;
    if (!deps.disaster) { facts = new Map(); return true; }
    try {
      facts = await deps.disaster.readFacts();
      return true;
    } catch (err) {
      deps.error(`✗ could not read the disaster records: ${failed(err)}`);
      return false;
    }
  };
  const factsOf = (id: string): TenantDisasterFacts => facts?.get(id) ?? NO_FACTS;
  const skippable = (t: MigrateTenantRow) => skipLost && hasLiveProof(factsOf(t.id));

  // Normal mode tries to list tenants first: step 0 needs their pending counts before anything is migrated. A brand-new
  // control plane has no tenants table yet; then the handshake runs (fail towards waiting) and tenants are listed after
  // the control-plane migration, as before.
  let tenantRows: MigrateTenantRow[] | null = null;
  let earlyListFailed = false;
  if (!check) {
    try {
      tenantRows = await deps.listTenants();
    } catch {
      earlyListFailed = true;
    }
  }

  // ---- Control plane -------------------------------------------------------
  deps.log(check ? 'Checking control plane…' : 'Migrating control plane…');
  if (skipLost) deps.log('Skipping workspaces the disaster button proved lost (--skip-lost).');
  let controlPending = 0;
  try {
    controlPending = await deps.controlPending();
  } catch (err) {
    deps.error(`✗ control plane ${check ? 'check' : 'migration'} failed: ${failed(err)}`);
    return 1;
  }

  let lock: HeldLock | null = null;
  let lockLost = false;
  const counts = new Map<string, number>();
  const excluded = new Set<string>();
  if (!check) {
    if (!(await loadFacts())) return 1;
    const scope = tenantRows ? (onlySlug ? tenantRows.filter((t) => t.slug === onlySlug) : tenantRows) : [];
    if (earlyListFailed || (await anythingPending(deps, controlPending, scope, concurrency, counts, skippable, excluded))) {
      try {
        lock = await takeMigrateLock(deps);
      } catch (err) {
        deps.error(`✗ could not take the migration run lock: ${failed(err)}`);
        return 1;
      }
      if (!lock) {
        deps.error('✗ A backup run is still active. Re-run deploy-prod later; nothing was changed.');
        return 1;
      }
      lock.onLost(() => { lockLost = true; });
    }
  }

  try {
    if (check) {
      deps.log(controlPending === 0 ? '✓ control plane is current' : `• control plane has ${controlPending} pending migration(s)`);
    } else {
      try {
        await deps.migrateControl();
        deps.log(controlPending > 0 ? '✓ control plane migrated' : '✓ control plane already up-to-date');
      } catch (err) {
        deps.error(`✗ control plane migration failed: ${failed(err)}`);
        return 1;
      }
    }

    if (check || earlyListFailed) {
      tenantRows = await listTenants();
      if (!tenantRows) return 1;
    }
    if (!(await loadFacts())) return 1;
    let rows = tenantRows!;
    if (onlySlug) {
      rows = rows.filter((t) => t.slug === onlySlug);
      if (rows.length === 0) {
        deps.error(`✗ No tenant with slug "${onlySlug}" in status (${MIGRATABLE_TENANT_STATUSES.join(', ')}).`);
        return 1;
      }
    }
    const tenantRowsToRun = rows;
    let migratedRowWarnings = 0;

    /** §6.0 skip: `--check` records nothing (D1); a normal run must record the skip, or the tenant is FAILED. */
    const skipLostTenant = async (t: TenantToMigrate): Promise<{ outcome: TenantOutcome; detail: string } | null> => {
      if (!skipLost || !hasLiveProof(factsOf(t.id))) return null;
      if (check || !deps.disaster) return { outcome: 'skipped', detail: SKIPPED_DETAIL };
      try {
        await deps.disaster.append({ tenantId: t.id, kind: 'skip', status: 'skipped', oldProjectId: t.neonProjectId });
        return { outcome: 'skipped', detail: SKIPPED_DETAIL };
      } catch (err) {
        return { outcome: 'FAILED', detail: `skip not recorded: ${failed(err)}` };
      }
    };

    // Reuse step 0's counts (each once): the migration pass doesn't count a tenant twice.
    const tenantDeps: TenantMigrationDeps = {
      ...deps.tenant,
      pendingCount: async (url: string) => {
        const n = counts.get(url);
        if (n !== undefined) { counts.delete(url); return n; }
        return deps.tenant.pendingCount(url);
      },
      onCountFailed: skipLost ? (t) => skipLostTenant(t) : undefined,
    };

    // ---- Tenants -------------------------------------------------------------
    deps.log(`\n${check ? 'Checking' : 'Migrating'} ${tenantRowsToRun.length} tenant(s)…`);
    let anyTenantFailed = false;
    let anyTenantPending = false;
    const results = await runWithConcurrency(tenantRowsToRun, concurrency, async (t): Promise<TenantResult> => {
      const startedAt = Date.now();
      const done = (outcome: TenantOutcome, detail: string, byId = false): TenantResult => {
        if (outcome === 'FAILED') anyTenantFailed = true;
        if (outcome === 'pending') anyTenantPending = true;
        return { label: byId ? t.id : t.slug, status: t.status, outcome, detail, durationMs: Date.now() - startedAt };
      };
      if (lockLost) return done('FAILED', 'migration run lock lost; not started');
      let url: string;
      try {
        // T7: dbUrlEncrypted is only null for a tombstoned ('deleted') tenant, never listed here.
        url = deps.decryptUrl(t.dbUrlEncrypted!);
      } catch (err) {
        return done('FAILED', deps.redact(String((err as Error)?.message ?? err)));
      }

      // §6.0: excluded from step 0 and the run holds no lock → never migrate it; it reconnected, so its proof stops counting.
      if (!check && excluded.has(t.id) && !lock) {
        try {
          await deps.tenant.pendingCount(url);
        } catch {
          const skip = await skipLostTenant(t);
          if (skip) return done(skip.outcome, skip.detail, true);
          return done('FAILED', 'proof no longer live; connection failed', true);
        }
        if (deps.disaster) {
          try {
            await deps.disaster.append({ tenantId: t.id, kind: 'proof', status: 'reachable-again', oldProjectId: t.neonProjectId });
          } catch { /* FAILED either way */ }
        }
        return done('FAILED', RECONNECTED_DETAIL, true);
      }

      const r = await migrateOneTenant(t, url, check, tenantDeps);
      const byId = skipLost && (r.detail === SKIPPED_DETAIL || r.detail.startsWith('skip not recorded'));
      if (!check && deps.disaster && (r.outcome === 'migrated' || r.outcome === 'up-to-date')) {
        const f = factsOf(t.id);
        if (hasLiveProof(f)) {
          try {
            await deps.disaster.append({ tenantId: t.id, kind: 'proof', status: 'reachable-again', oldProjectId: t.neonProjectId });
          } catch (err) {
            return done('FAILED', `migrated, but reachable-again not recorded: ${failed(err)}`);
          }
        }
        if (needsMigratedRow(f)) {
          try {
            await deps.disaster.append({ tenantId: t.id, kind: 'skip', status: 'migrated', oldProjectId: t.neonProjectId });
          } catch (err) {
            migratedRowWarnings++;
            deps.error(`! ${t.id}: migrated, but the "migrated" record failed (${failed(err)}); the digest keeps asking for a deploy`);
          }
        }
      }
      return done(r.outcome, r.detail, byId);
    });

    printTable(deps.log, results);

    if (check) {
      if (anyTenantFailed) return 1;
      return controlPending > 0 || anyTenantPending ? 2 : 0;
    }
    if (lockLost) {
      deps.error('✗ The migration run lock was lost (connection closed); stopped before the next database. Re-run deploy-prod.');
      return 1;
    }
    if (anyTenantFailed) {
      deps.error(`✗ ${results.filter((r) => r.outcome === 'FAILED').length} tenant(s) failed to migrate.`);
      return 1;
    }
    if (migratedRowWarnings > 0) deps.error(`! ${migratedRowWarnings} "migrated" record(s) could not be written (warning only).`);
    deps.log('✓ All databases migrated successfully.');
    return 0;
  } finally {
    if (lock) await lock.release();
  }
}
