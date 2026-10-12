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
 *   tsx scripts/migrate-all.ts                  # migrate control plane + all tenants
 *   tsx scripts/migrate-all.ts --check           # report pending counts only, apply nothing
 *   tsx scripts/migrate-all.ts --concurrency 5   # override the default tenant concurrency (3)
 *   tsx scripts/migrate-all.ts --tenant acme     # limit the tenant loop to one slug
 *
 * Required env (loaded from .env.local then .env, mirroring scripts/seed-demo.ts):
 *   CONTROL_PLANE_DATABASE_URL, ENCRYPTION_KEY (must match the running app's key)
 *
 * Exit codes:
 *   Normal mode: 0 if every database is migrated/current, 1 if any tenant (or the control
 *                plane) failed.
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

const CONTROL_PLANE_MIGRATIONS_FOLDER = './drizzle/control-plane';
const TENANT_MIGRATIONS_FOLDER = './drizzle';
const DEFAULT_CONCURRENCY = 3;
const RETRYABLE_TENANT_STATUSES = ['active', 'suspended', 'provisioning'] as const;

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

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail(`--concurrency must be a positive integer (got "${argv[concurrencyFlagIdx + 1]}").`);
  }
  return { check, concurrency, tenant };
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

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
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

type TenantResult = {
  slug: string;
  status: string;
  outcome: 'migrated' | 'up-to-date' | 'pending' | 'current' | 'FAILED';
  detail: string;
  durationMs: number;
};

function printTable(rows: TenantResult[]) {
  const header = ['slug', 'status', 'result', 'duration'];
  const widths = [
    Math.max(header[0].length, ...rows.map((r) => r.slug.length)),
    Math.max(header[1].length, ...rows.map((r) => r.status.length)),
    Math.max(header[2].length, ...rows.map((r) => `${r.outcome}${r.detail ? `: ${r.detail}` : ''}`.length)),
    Math.max(header[3].length, ...rows.map((r) => `${r.durationMs}ms`.length)),
  ];
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  |  ');
  console.log('\n' + line(header));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) {
    const result = `${r.outcome}${r.detail ? `: ${r.detail}` : ''}`;
    console.log(line([r.slug, r.status, result, `${r.durationMs}ms`]));
  }
  console.log('');
}

async function main() {
  const { check, concurrency, tenant: onlySlug } = parseArgs(process.argv.slice(2));

  const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');
  if (!process.env.ENCRYPTION_KEY) {
    fail(
      'ENCRYPTION_KEY is not set (checked .env.local and .env).\n' +
      '  It MUST match the running app, or tenant connection strings cannot be decrypted.'
    );
  }

  // ---- Control plane -------------------------------------------------------
  console.log(check ? 'Checking control plane…' : 'Migrating control plane…');
  let controlPending = 0;
  try {
    if (check) {
      controlPending = await withConnectionRetry(() =>
        getPendingMigrationCount(controlUrl!, CONTROL_PLANE_MIGRATIONS_FOLDER));
      console.log(controlPending === 0
        ? '✓ control plane is current'
        : `• control plane has ${controlPending} pending migration(s)`);
    } else {
      controlPending = await withConnectionRetry(() =>
        getPendingMigrationCount(controlUrl!, CONTROL_PLANE_MIGRATIONS_FOLDER));
      await withConnectionRetry(() =>
        migrateTenantDatabase(controlUrl!, { migrationsFolder: CONTROL_PLANE_MIGRATIONS_FOLDER }));
      console.log(controlPending > 0 ? '✓ control plane migrated' : '✓ control plane already up-to-date');
    }
  } catch (err) {
    fail(`control plane ${check ? 'check' : 'migration'} failed: ${redact(String((err as Error)?.message ?? err))}`);
  }

  // ---- Tenants ---------------------------------------------------------------
  const controlSql = postgres(controlUrl!, { max: 1 });
  const controlDrizzle = drizzle(controlSql);
  let tenantRows: Array<{ slug: string; status: string; dbUrlEncrypted: string }>;
  try {
    const where = inArray(tenants.status, [...RETRYABLE_TENANT_STATUSES]);
    tenantRows = await controlDrizzle
      .select({ slug: tenants.slug, status: tenants.status, dbUrlEncrypted: tenants.dbUrlEncrypted })
      .from(tenants)
      .where(where);
  } finally {
    await controlSql.end();
  }

  if (onlySlug) {
    tenantRows = tenantRows.filter((t) => t.slug === onlySlug);
    if (tenantRows.length === 0) {
      fail(`No tenant with slug "${onlySlug}" in status (${RETRYABLE_TENANT_STATUSES.join(', ')}).`);
    }
  }

  console.log(`\n${check ? 'Checking' : 'Migrating'} ${tenantRows.length} tenant(s)…`);

  let anyTenantFailed = false;
  let anyTenantPending = false;

  const results = await runWithConcurrency(tenantRows, concurrency, async (t): Promise<TenantResult> => {
    const startedAt = Date.now();
    try {
      const url = decrypt(t.dbUrlEncrypted);
      if (check) {
        const pending = await withConnectionRetry(() => getPendingMigrationCount(url, TENANT_MIGRATIONS_FOLDER));
        if (pending > 0) anyTenantPending = true;
        return {
          slug: t.slug, status: t.status,
          outcome: pending > 0 ? 'pending' : 'current',
          detail: pending > 0 ? `${pending} migration(s)` : '',
          durationMs: Date.now() - startedAt,
        };
      }
      const pendingBefore = await withConnectionRetry(() => getPendingMigrationCount(url, TENANT_MIGRATIONS_FOLDER));
      await withConnectionRetry(() => migrateTenantDatabase(url, { migrationsFolder: TENANT_MIGRATIONS_FOLDER }));
      return {
        slug: t.slug, status: t.status,
        outcome: pendingBefore > 0 ? 'migrated' : 'up-to-date',
        detail: '',
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      anyTenantFailed = true;
      return {
        slug: t.slug, status: t.status, outcome: 'FAILED',
        detail: redact(String((err as Error)?.message ?? err)),
        durationMs: Date.now() - startedAt,
      };
    }
  });

  printTable(results);

  if (check) {
    if (anyTenantFailed) process.exit(1);
    process.exit(controlPending > 0 || anyTenantPending ? 2 : 0);
  }

  if (anyTenantFailed) {
    console.error(`✗ ${results.filter((r) => r.outcome === 'FAILED').length} tenant(s) failed to migrate.`);
    process.exit(1);
  }
  console.log('✓ All databases migrated successfully.');
  process.exit(0);
}

main().catch((err) => {
  console.error('migrate-all failed:', redact(String(err?.message ?? err)));
  process.exit(1);
});
