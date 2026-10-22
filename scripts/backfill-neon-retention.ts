/**
 * LB-D1 backfill (feature-plan-launch-blockers.md P6 §1): set `history_retention_seconds` on every existing tenant Neon
 * project to the policy value (7 days; NEON_HISTORY_RETENTION_SECONDS overrides — a Free-plan staging org rejects
 * anything above 21600). New projects get it at creation (src/lib/tenant/neon.ts createNeonDatabase).
 *
 * Usage:
 *   npm run backfill:neon-retention            # apply (idempotent)
 *   npm run backfill:neon-retention -- --check # report current values, change nothing (GET only)
 *
 * Tenants without `neon_project_id` are listed as needing manual action. A `deleting` tenant whose project is already
 * gone (Neon 404) is skipped. Exits non-zero if any project failed.
 *
 * Required env (loaded from .env.local then .env): CONTROL_PLANE_DATABASE_URL, NEON_API_KEY
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ne } from 'drizzle-orm';
import { tenants } from '../src/db/control-plane/schema';
import { getNeonHistoryRetention, setNeonHistoryRetention } from '../src/lib/tenant/neon';
import { tenantDbHistoryRetentionSeconds } from '../src/lib/tenant/lifecycle-config';
import { printTargetBanner } from './lib/target';
import { runRetentionBackfill } from './lib/retention-backfill';

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  printTargetBanner();
  const check = process.argv.includes('--check');

  const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');
  if (!process.env.NEON_API_KEY) fail('NEON_API_KEY is not set (checked .env.local and .env).');
  const target = tenantDbHistoryRetentionSeconds();

  const sql = postgres(controlUrl!, { max: 1 });
  try {
    const rows = await drizzle(sql)
      .select({ slug: tenants.slug, status: tenants.status, neonProjectId: tenants.neonProjectId })
      .from(tenants)
      .where(ne(tenants.status, 'deleted'))
      .orderBy(tenants.slug);

    console.log(`${check ? 'Checking' : 'Setting'} history retention (${target} s) on ${rows.length} tenant project(s):\n`);
    const report = await runRetentionBackfill(rows, target, { check }, {
      get: getNeonHistoryRetention,
      set: setNeonHistoryRetention,
      log: (line) => console.log(line),
    });

    console.log('');
    if (check) console.log(`${report.alreadyOk.length} already at ${target} s, ${report.wouldUpdate.length} would change.`);
    else console.log(`${report.updated.length} updated.`);
    if (report.skippedDeleted.length) console.log(`${report.skippedDeleted.length} skipped (deleting, project gone): ${report.skippedDeleted.join(', ')}`);
    if (report.manual.length) console.log(`⚠ ${report.manual.length} need manual action (no neon_project_id): ${report.manual.join(', ')}`);
    if (report.failed.length) {
      console.error(`✗ ${report.failed.length} failed: ${report.failed.map((f) => `${f.slug} (${f.error})`).join('; ')}`);
      process.exit(1);
    }
    process.exit(0);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('backfill-neon-retention failed:', err?.message ?? err);
  process.exit(1);
});
