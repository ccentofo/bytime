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
 */
import { BACKUP_LOCK_KEY, MIGRATE_RUN_LOCK_KEY } from '../../src/lib/tenant/backup-locks';
import { acquireLock, probeClient, type Connect, type HeldLock, type LockTiming } from '../backup/lib/locks';
import { isAdvisoryLockHeld, waitForLock } from '../backup/lib/backup-wait';
import { MIGRATABLE_TENANT_STATUSES, migrateOneTenant, type TenantMigrationDeps, type TenantOutcome } from './tenant-migration';

export interface MigrateAllOptions {
  check: boolean;
  concurrency: number;
  onlySlug?: string;
}

export interface MigrateTenantRow {
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
  lock?: {
    connect?: Connect;
    timing?: LockTiming;
    waitMaxMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
}

type TenantResult = { slug: string; status: string; outcome: TenantOutcome; detail: string; durationMs: number };

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
    Math.max(header[0].length, ...rows.map((r) => r.slug.length)),
    Math.max(header[1].length, ...rows.map((r) => r.status.length)),
    Math.max(header[2].length, ...rows.map((r) => `${r.outcome}${r.detail ? `: ${r.detail}` : ''}`.length)),
    Math.max(header[3].length, ...rows.map((r) => `${r.durationMs}ms`.length)),
  ];
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  |  ');
  log('\n' + line(header));
  log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) log(line([r.slug, r.status, `${r.outcome}${r.detail ? `: ${r.detail}` : ''}`, `${r.durationMs}ms`]));
  log('');
}

/**
 * Step 0: true when anything is pending or any count can't be read (fail towards waiting). Counts run with the run's
 * concurrency and are kept in `counts` (by URL) so the migration pass reuses them instead of counting twice. A
 * `deleting` tenant whose database is CONFIRMED gone (the existing absence check) is not pending: its count can't be
 * read, and an app-only deploy must not wait on it.
 */
async function anythingPending(deps: MigrateAllDeps, controlPending: number, rows: MigrateTenantRow[], concurrency: number, counts: Map<string, number>): Promise<boolean> {
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
  const failed = (err: unknown) => deps.redact(String((err as Error)?.message ?? err));
  const listTenants = async (): Promise<MigrateTenantRow[] | null> => {
    try {
      return await deps.listTenants();
    } catch (err) {
      deps.error(`migrate-all failed: ${failed(err)}`);
      return null;
    }
  };

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
  if (!check) {
    const scope = tenantRows ? (onlySlug ? tenantRows.filter((t) => t.slug === onlySlug) : tenantRows) : [];
    if (earlyListFailed || (await anythingPending(deps, controlPending, scope, concurrency, counts))) {
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
    let rows = tenantRows!;
    if (onlySlug) {
      rows = rows.filter((t) => t.slug === onlySlug);
      if (rows.length === 0) {
        deps.error(`✗ No tenant with slug "${onlySlug}" in status (${MIGRATABLE_TENANT_STATUSES.join(', ')}).`);
        return 1;
      }
    }
    const tenantRowsToRun = rows;
    // Reuse step 0's counts (each once): the migration pass doesn't count a tenant twice.
    const tenantDeps = {
      ...deps.tenant,
      pendingCount: async (url: string) => {
        const n = counts.get(url);
        if (n !== undefined) { counts.delete(url); return n; }
        return deps.tenant.pendingCount(url);
      },
    };

    // ---- Tenants -------------------------------------------------------------
    deps.log(`\n${check ? 'Checking' : 'Migrating'} ${tenantRowsToRun.length} tenant(s)…`);
    let anyTenantFailed = false;
    let anyTenantPending = false;
    const results = await runWithConcurrency(tenantRowsToRun, concurrency, async (t): Promise<TenantResult> => {
      const startedAt = Date.now();
      if (lockLost) {
        anyTenantFailed = true;
        return { slug: t.slug, status: t.status, outcome: 'FAILED', detail: 'migration run lock lost; not started', durationMs: 0 };
      }
      let url: string;
      try {
        // T7: dbUrlEncrypted is only null for a tombstoned ('deleted') tenant, never listed here.
        url = deps.decryptUrl(t.dbUrlEncrypted!);
      } catch (err) {
        anyTenantFailed = true;
        return { slug: t.slug, status: t.status, outcome: 'FAILED', detail: deps.redact(String((err as Error)?.message ?? err)), durationMs: Date.now() - startedAt };
      }
      const { outcome, detail } = await migrateOneTenant(t, url, check, tenantDeps);
      if (outcome === 'FAILED') anyTenantFailed = true;
      if (outcome === 'pending') anyTenantPending = true;
      return { slug: t.slug, status: t.status, outcome, detail, durationMs: Date.now() - startedAt };
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
    deps.log('✓ All databases migrated successfully.');
    return 0;
  } finally {
    if (lock) await lock.release();
  }
}
