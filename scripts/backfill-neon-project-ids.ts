/**
 * One-off backfill: set `neon_project_id` for existing tenants provisioned before T4 started
 * persisting it at creation time (feature-plan-terms-compliance.md T7).
 *
 * Looks each tenant up by its Neon project NAME (`cadenzpoint-<slug>`, set at creation — see
 * src/lib/tenant/neon.ts's createNeonDatabase) via the Neon API, and records the matching
 * project id. Idempotent: only touches tenants where `neon_project_id IS NULL`.
 *
 * Usage:
 *   tsx scripts/backfill-neon-project-ids.ts          # apply
 *   tsx scripts/backfill-neon-project-ids.ts --check  # report what would change, apply nothing
 *
 * Required env (loaded from .env.local then .env): CONTROL_PLANE_DATABASE_URL, NEON_API_KEY
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { tenants } from '../src/db/control-plane/schema';
import { findNeonProjectIdByName } from '../src/lib/tenant/neon';
import { printTargetBanner } from './lib/target';

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

  const sql = postgres(controlUrl!, { max: 1 });
  const db = drizzle(sql);

  try {
    // Only tenants that still have a database (never tombstoned) and no recorded project id yet.
    const candidates = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(and(isNull(tenants.neonProjectId), isNotNull(tenants.dbUrlEncrypted)));

    if (candidates.length === 0) {
      console.log('✓ No tenants need backfilling — nothing to do.');
      process.exit(0);
    }

    console.log(`${check ? 'Would backfill' : 'Backfilling'} ${candidates.length} tenant(s):\n`);

    let notFound = 0;
    for (const t of candidates) {
      const projectName = `cadenzpoint-${t.slug}`;
      const projectId = await findNeonProjectIdByName(projectName);
      if (!projectId) {
        console.log(`  ${t.slug}: no Neon project found named "${projectName}" — skipping (local dev tenant?)`);
        notFound++;
        continue;
      }
      console.log(`  ${t.slug}: neon_project_id → ${projectId}`);
      if (!check) {
        await db.update(tenants).set({ neonProjectId: projectId, updatedAt: new Date() }).where(eq(tenants.id, t.id));
      }
    }

    console.log(`\n${check ? 'Dry run complete — no changes applied.' : '✓ Backfill complete.'}${notFound > 0 ? ` (${notFound} not found in Neon.)` : ''}`);
    process.exit(0);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('backfill-neon-project-ids failed:', err?.message ?? err);
  process.exit(1);
});
