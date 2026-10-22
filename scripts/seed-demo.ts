/**
 * DEMO tenant seeding — provision a fully-populated demo tenant in one command.
 *
 * Unlike seed-tenant.ts (blank-slate: admin user only), this loads the FULL 6-month GovCon
 * dataset (contracts, CLINs, employees, timesheets, approvals) so a live demo shows a believable,
 * populated product. Use it to stand up the 2–3 demo workspaces for the Vercel + Neon demo.
 *
 * What it does, idempotently:
 *   1. Migrate the tenant DB to the current schema.
 *   2. Seed the rich demo dataset (reuses seedRichData from seed-full.ts).
 *   3. Register the tenant in the control plane (encrypted URL, status active, lifecycle-exempt per F1).
 *
 * Requires CONTROL_PLANE_DATABASE_URL and ENCRYPTION_KEY (the SAME key the running app uses,
 * or it cannot decrypt the tenant URL). Reads .env.local then .env (Next.js precedence).
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts <slug> <tenantDbUrl> [displayName] [emailDomain]
 *
 * Example (Neon single-project demo — one DB per tenant inside one project):
 *   npx tsx scripts/seed-demo.ts acme \
 *     'postgresql://USER:PASS@ep-xxx.neon.tech/tenant_acme?sslmode=require' \
 *     'Acme Defense'
 *
 * After it runs, log in at https://<slug>.cadenzpoint.com with admin@cadenzpoint.dev / Password123!
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { registerTenant } from './register-tenant';
import { encrypt } from '../src/lib/encryption';
import { seedRichData } from './seed-full';
import { printTargetBanner } from './lib/target';

const [
  slug,
  tenantDbUrl,
  displayName,
  emailDomain = 'cadenzpoint.dev',
] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wipeDemoData = process.argv.includes('--wipe-demo-data');

const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!slug || !tenantDbUrl) {
  fail('Usage: tsx scripts/seed-demo.ts <slug> <tenantDbUrl> [displayName] [emailDomain] [--wipe-demo-data]');
}
if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');
if (!process.env.ENCRYPTION_KEY) {
  fail(
    'ENCRYPTION_KEY is not set (checked .env.local and .env).\n' +
    'It MUST match the running app, or the app cannot decrypt the tenant URL this script stores.',
  );
}

async function main() {
  printTargetBanner();
  // 1. Migrate the tenant DB. Tolerate a DB that already has the schema but no migration
  //    journal (42P07 = duplicate table, 42710 = duplicate object/type).
  const tsql = postgres(tenantDbUrl, { max: 1 });
  const tdb = drizzle(tsql);
  console.log(`→ Migrating tenant DB for "${slug}"...`);
  try {
    await migrate(tdb, { migrationsFolder: './drizzle' });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === '42P07' || code === '42710') {
      console.log('  • schema already present (no migration journal) — continuing.');
    } else {
      await tsql.end();
      throw err;
    }
  }

  // 2. Seed the rich demo dataset (clears + repopulates — safe to re-run).
  await seedRichData(tdb, { emailDomain, wipeDemoData });
  await tsql.end();

  // 3. Register in the control plane (encrypted URL, status active).
  // F1: demo workspaces are lifecycle-exempt (no trial expiry, no lifecycle emails, never scheduled for deletion).
  await registerTenant(controlUrl!, {
    slug, name: displayName || slug, dbUrlEncrypted: encrypt(tenantDbUrl), exempt: true, actor: 'seed-demo',
  });

  const rootDomain = process.env.APP_ROOT_DOMAIN ?? 'cadenzpoint.com';
  console.log(`\n✓ Demo tenant "${slug}" is ACTIVE and populated.`);
  console.log(`  Visit:  https://${slug}.${rootDomain}`);
  console.log(`  Login:  admin@${emailDomain} / Password123!`);
}

main().catch((err) => {
  console.error('seed-demo failed:', err);
  process.exit(1);
});
