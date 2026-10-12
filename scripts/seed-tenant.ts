/**
 * LOCAL TEST seeding — create + register a tenant so you can exercise multi-tenant routing
 * locally at http://<slug>.localhost:3000. This is a throwaway dev stand-in for blueprint 5
 * (automated provisioning). It deliberately sets a KNOWN password so you can log in right
 * away — TEST ONLY; never use this to create real customer accounts.
 *
 * BLANK-SLATE policy (matches BP5): a new tenant gets ONLY an admin user — no indirect codes,
 * no contracts, no pay-period row. Pay period defaults to semi-monthly via DEFAULT_PERIOD_CONFIG.
 * The admin adds charge codes / contracts via the UI (or imports them).
 *
 * Requires CONTROL_PLANE_DATABASE_URL and (ideally) ENCRYPTION_KEY in the environment — the
 * SAME ENCRYPTION_KEY the running app uses, or it won't be able to decrypt the tenant URL.
 *
 * Usage:
 *   npx tsx scripts/seed-tenant.ts <slug> <tenantDbUrl> [adminEmail] [adminName] [password]
 *
 * Example:
 *   npx tsx scripts/seed-tenant.ts acme postgresql://bytime:bytime_dev@localhost:5432/bytime_acme
 */
import dotenv from 'dotenv';
// Match Next.js env precedence: .env.local overrides .env. (`dotenv/config` alone reads only
// .env, which would miss secrets you keep in .env.local — e.g. ENCRYPTION_KEY — and cause the
// app to fail decrypting tenants this script encrypted.)
dotenv.config({ path: ['.env.local', '.env'] });
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import * as schema from '../src/db/schema';
import { tenants } from '../src/db/control-plane/schema';
import { encrypt } from '../src/lib/encryption';

const [
  slug,
  tenantDbUrl,
  adminEmail = slug ? `admin@${slug}.test` : '',
  adminName = 'Admin',
  password = 'Password123!',
] = process.argv.slice(2);

const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!slug || !tenantDbUrl) {
  fail('Usage: tsx scripts/seed-tenant.ts <slug> <tenantDbUrl> [adminEmail] [adminName] [password]');
}
if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');
if (!process.env.ENCRYPTION_KEY) {
  fail(
    'ENCRYPTION_KEY is not set (checked .env.local and .env).\n' +
    'Generate one and add it where the app reads it (so app + this script share the SAME key):\n' +
    '  echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env\n' +
    'Without an identical key, the running app cannot decrypt the tenant URL this script stores.',
  );
}

async function main() {
  const email = adminEmail.toLowerCase().trim();

  // 1. Migrate the tenant DB to the current schema. Tolerate a DB that already has the schema
  //    but no migration journal (e.g. one created via `drizzle-kit push`) — common when reusing
  //    an existing dev DB as a tenant. 42P07 = duplicate table, 42710 = duplicate object/type.
  const tsql = postgres(tenantDbUrl, { max: 1 });
  const tdb = drizzle(tsql, { schema });
  console.log(`→ Migrating tenant DB for "${slug}"...`);
  try {
    await migrate(tdb, { migrationsFolder: './drizzle' });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === '42P07' || code === '42710') {
      console.log('  • schema already present (no migration journal) — skipping migrations.');
      console.log('    If this DB predates recent migrations, sync it with: ' +
        `DATABASE_URL='${tenantDbUrl}' npm run db:push`);
    } else {
      await tsql.end();
      throw err;
    }
  }

  // 2. Admin user with a KNOWN test password (so you can log in immediately).
  //    Blank slate: NO indirect codes, NO contracts are seeded.
  const [existing] = await tdb.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 12);
    const [admin] = await tdb.insert(schema.users)
      .values({ email, fullName: adminName, role: 'admin', isActive: true, passwordHash })
      .returning({ id: schema.users.id });
    await tdb.insert(schema.notificationPreferences).values({ userId: admin.id });
    console.log(`  ✓ admin user ${email}`);
  } else {
    console.log(`  • admin ${email} already exists — left unchanged`);
  }
  await tsql.end();

  // 3. Register in the control plane (encrypted URL, status active).
  const csql = postgres(controlUrl!, { max: 1 });
  const cdb = drizzle(csql);
  await cdb.insert(tenants)
    .values({ slug, name: slug, dbUrlEncrypted: encrypt(tenantDbUrl), status: 'active', plan: 'trial' })
    .onConflictDoUpdate({
      target: tenants.slug,
      set: { dbUrlEncrypted: encrypt(tenantDbUrl), status: 'active', updatedAt: new Date() },
    });
  await csql.end();

  console.log(`\n✓ Tenant "${slug}" is ACTIVE.`);
  console.log(`  Visit:  http://${slug}.localhost:3000`);
  console.log(`  Login:  ${email} / ${password}`);
}

main().catch((err) => {
  console.error('seed-tenant failed:', err);
  process.exit(1);
});
