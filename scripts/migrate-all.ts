/**
 * Migrate the control plane AND every tenant database to the latest schema.
 *
 * This is the deploy-time rollout step for database-per-tenant: a schema-changing deploy must
 * reach the control plane (`drizzle/control-plane`) and every tenant DB (`drizzle/`) BEFORE the
 * new code goes live, or every tenant breaks the moment the new code starts querying the old
 * schema. See MIGRATIONS.md for the full rollout runbook and the expand/contract rule that keeps
 * each individual migration backward-compatible with the currently-deployed code.
 *
 * Usage:
 *   npm run db:migrate:all                           # migrate control plane + all tenants
 *   npm run db:migrate:check                         # report pending counts only, apply nothing
 *   npm run db:migrate:all -- --concurrency 5        # override the default tenant concurrency (3)
 *   npm run db:migrate:all -- --tenant acme          # limit the tenant loop to one slug
 *   npm run db:migrate:all -- --skip-lost            # skip workspaces the disaster button proved lost
 *                                                    # (feature-plan-disaster-restore.md §6.0; also with --check)
 *
 * Runs under Node's `react-server` condition (package.json) so the `server-only` guard in src/lib/tenant/* — needed
 * for the deleted-database check — resolves to its no-op build.
 *
 * Required env (loaded from .env.local then .env, mirroring scripts/seed-demo.ts):
 *   CONTROL_PLANE_DATABASE_URL, ENCRYPTION_KEY (must match the running app's key)
 *
 * Backups (feature-plan-database-backups.md §6.4): when anything is pending, the run takes MIGRATE_RUN_LOCK_KEY and waits
 * (up to 30 min) while a backup run holds its lock, then refuses with nothing changed. --check never waits. The run logic
 * lives in scripts/lib/migrate-all-run.ts; this file is the CLI.
 *
 * Exit codes:
 *   Normal mode: 0 if every database is migrated/current (or skipped: a `deleting` tenant whose
 *                database is confirmed deleted), 1 if any tenant (or the control plane) failed.
 *   --check:     0 if everything is current, 2 if anything is pending, 1 on a connection/other
 *                error while checking.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import { tenants } from '../src/db/control-plane/schema';
import { decrypt } from '../src/lib/encryption';
import { migrateTenantDatabase, getPendingMigrationCount } from '../src/lib/tenant/migrate-tenant';
import { classifyDatabase } from '../src/lib/tenant/delete-tenant';
import { databaseExists, neonProjectExists } from '../src/lib/tenant/neon';
import { printTargetBanner } from './lib/target';
import { MIGRATABLE_TENANT_STATUSES, isTenantDatabaseConfirmedAbsent } from './lib/tenant-migration';
import { runMigrateAll, type DisasterActionInput } from './lib/migrate-all-run';
import { readDisasterFacts, appendDisasterAction, migrateRunId } from './lib/disaster-records';

const CONTROL_PLANE_MIGRATIONS_FOLDER = './drizzle/control-plane';
const TENANT_MIGRATIONS_FOLDER = './drizzle';
const DEFAULT_CONCURRENCY = 3;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const check = argv.includes('--check');
  const concurrencyFlagIdx = argv.indexOf('--concurrency');
  const concurrency = concurrencyFlagIdx !== -1
    ? Number(argv[concurrencyFlagIdx + 1])
    : DEFAULT_CONCURRENCY;
  const tenantFlagIdx = argv.indexOf('--tenant');
  const tenant = tenantFlagIdx !== -1 ? argv[tenantFlagIdx + 1] : undefined;
  const skipLost = argv.includes('--skip-lost');

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail(`--concurrency must be a positive integer (got "${argv[concurrencyFlagIdx + 1]}").`);
  }
  return { check, concurrency, tenant, skipLost };
}

/** Never let a raw driver/connection-string error reach the console — only tenant slugs are logged. */
function redact(message: string): string {
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted-connection-string]');
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
    ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === 'ECONNREFUSED'
    || code === 'ENOTFOUND'
    || code === 'ETIMEDOUT'
    || code === 'CONNECT_TIMEOUT'
    || code === 'CONNECTION_CLOSED'
    || code === 'CONNECTION_ENDED'
    || code === 'CONNECTION_DESTROYED';
}

async function withConnectionRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    console.log('  … connection error, retrying once after 5s (possible cold start)');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return fn();
  }
}

async function main() {
  printTargetBanner();
  const { check, concurrency, tenant: onlySlug, skipLost } = parseArgs(process.argv.slice(2));

  const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');
  if (!process.env.ENCRYPTION_KEY) {
    fail(
      'ENCRYPTION_KEY is not set (checked .env.local and .env).\n' +
      '  It MUST match the running app, or tenant connection strings cannot be decrypted.'
    );
  }

  const listTenants = async () => {
    const controlSql = postgres(controlUrl!, { max: 1 });
    try {
      return await drizzle(controlSql)
        .select({ id: tenants.id, slug: tenants.slug, status: tenants.status, dbUrlEncrypted: tenants.dbUrlEncrypted, neonProjectId: tenants.neonProjectId })
        .from(tenants)
        .where(inArray(tenants.status, [...MIGRATABLE_TENANT_STATUSES]));
    } finally {
      await controlSql.end();
    }
  };

  // feature-plan-disaster-restore.md §6.0: one control-plane client for the disaster records, ended before exit.
  const recordsSql = postgres(controlUrl!, { max: 1, onnotice: () => {} });
  const runId = migrateRunId(new Date());
  const code = await runMigrateAll({ check, concurrency, onlySlug, skipLost }, {
    controlUrl: controlUrl!,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    redact,
    controlPending: () => withConnectionRetry(() => getPendingMigrationCount(controlUrl!, CONTROL_PLANE_MIGRATIONS_FOLDER)),
    migrateControl: () => withConnectionRetry(() => migrateTenantDatabase(controlUrl!, { migrationsFolder: CONTROL_PLANE_MIGRATIONS_FOLDER })),
    listTenants,
    decryptUrl: decrypt,
    disaster: {
      runId,
      readFacts: () => readDisasterFacts(recordsSql),
      append: (row: DisasterActionInput) => appendDisasterAction(recordsSql, runId, row),
    },
    tenant: {
      pendingCount: (url: string) => withConnectionRetry(() => getPendingMigrationCount(url, TENANT_MIGRATIONS_FOLDER)),
      migrate: (url: string) => withConnectionRetry(() => migrateTenantDatabase(url, { migrationsFolder: TENANT_MIGRATIONS_FOLDER })),
      confirmedAbsent: (t: { id: string; slug: string; status: string; neonProjectId: string | null }, url: string) =>
        isTenantDatabaseConfirmedAbsent(t, url, {
          classify: (u, row) => classifyDatabase(u, row, { dropSharedDatabase: true }), // existence check only — never drops
          neonProjectExists,
          databaseExists,
          hasNeonKey: Boolean(process.env.NEON_API_KEY),
        }),
      redact,
    },
  });
  await recordsSql.end({ timeout: 5 }).catch(() => {});
  process.exit(code);
}

main().catch((err) => {
  console.error('migrate-all failed:', redact(String(err?.message ?? err)));
  process.exit(1);
});
