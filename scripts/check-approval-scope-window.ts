/**
 * The approval-scope deploy-window check (feature-plan-approval-scope.md S9, §12.1). REPORT-ONLY: every tenant is read
 * in a READ ONLY transaction and nothing is written anywhere.
 *
 *   npm run scopes:window-check -- --since "$MIGRATE_START"      # every tenant
 *   npm run scopes:window-check -- --since "$MIGRATE_START" --tenant acme
 *
 * Run it right after the deploy that follows `db:migrate:all` goes live. For each tenant it lists what the OLD code may
 * have changed between the migration and the deploy; the founder fixes anything that should change by hand on
 * Assignments → Approval scope. Runs under Node's `react-server` condition (package.json), like migrate-all.ts.
 *
 * Required env (loaded from .env.local then .env): CONTROL_PLANE_DATABASE_URL, ENCRYPTION_KEY.
 * Exit codes: 0 = every tenant read (findings or not); 1 = bad arguments or a tenant couldn't be read.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import { tenants } from '../src/db/control-plane/schema';
import * as schema from '../src/db/schema';
import { decrypt } from '../src/lib/encryption';
import { printTargetBanner } from './lib/target';
import { MIGRATABLE_TENANT_STATUSES } from './lib/tenant-migration';
import {
  WINDOW_CAVEAT, approvalScopeWindowFindings, formatWindowFindings, parseWindowSince, windowErrorDetail,
} from '../src/server/internal/approval-scope-window';

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const sinceIdx = argv.indexOf('--since');
  const parsed = parseWindowSince(sinceIdx !== -1 ? argv[sinceIdx + 1] : undefined);
  if ('error' in parsed) fail(parsed.error);
  const tenantIdx = argv.indexOf('--tenant');
  return { since: parsed.since, tenant: tenantIdx !== -1 ? argv[tenantIdx + 1] : undefined };
}

async function main() {
  printTargetBanner();
  const { since, tenant: onlySlug } = parseArgs(process.argv.slice(2));
  const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');
  if (!process.env.ENCRYPTION_KEY) fail('ENCRYPTION_KEY is not set (checked .env.local and .env).');

  const controlSql = postgres(controlUrl, { max: 1 });
  let rows: Array<{ slug: string; dbUrlEncrypted: string | null }>;
  try {
    rows = await drizzle(controlSql).select({ slug: tenants.slug, dbUrlEncrypted: tenants.dbUrlEncrypted })
      .from(tenants).where(inArray(tenants.status, [...MIGRATABLE_TENANT_STATUSES]));
  } finally {
    await controlSql.end();
  }
  if (onlySlug) rows = rows.filter((t) => t.slug === onlySlug);
  if (rows.length === 0) fail(onlySlug ? `No tenant with slug "${onlySlug}".` : 'No tenants found.');

  console.log(`Approval-scope window check since ${since.toISOString()} — ${rows.length} tenant(s). Read-only.`);
  console.log(`${WINDOW_CAVEAT}\n`);
  let failed = false;
  for (const t of rows) {
    let sql: ReturnType<typeof postgres> | null = null;
    try {
      sql = postgres(decrypt(t.dbUrlEncrypted!), { max: 1 });
      const findings = await approvalScopeWindowFindings(drizzle(sql, { schema }) as never, since);
      for (const line of formatWindowFindings(t.slug, findings)) console.log(line);
    } catch (err) {
      failed = true;
      console.log(`✗ ${t.slug}: couldn't be read — ${windowErrorDetail(err)}`);
    } finally {
      if (sql) await sql.end({ timeout: 5 });
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
