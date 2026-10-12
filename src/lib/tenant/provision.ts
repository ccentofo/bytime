import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { getTenantBySlug, createTenantRecord, invalidateTenant } from '@/lib/tenant/registry';
import { getDbForUrl } from '@/db';
import * as schema from '@/db/schema';
import { createNeonDatabase } from './neon';
import { migrateTenantDatabase } from './migrate-tenant';

const RESERVED_SLUGS = new Set(['www', 'app', 'api', 'admin', 'static', 'assets', 'mail', 'support']);

export function isValidSlug(slug: string): boolean {
  // DNS label: 1–63 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen.
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

export type ProvisionInput = {
  slug: string;
  name: string;
  adminEmail: string;
  adminName: string;
  plan?: string;
  /** Override DB creation (tests / self-hosted). Defaults to Neon. */
  createDatabase?: (slug: string) => Promise<string>;
};

export type ProvisionResult = { slug: string; adminUserId: string };

/**
 * Provision a new tenant end-to-end. Idempotent and resumable: safe to re-run for a
 * slug stuck in 'provisioning'. Throws on hard failure, leaving status='provisioning'.
 */
export async function provisionTenant(input: ProvisionInput): Promise<ProvisionResult> {
  const slug = input.slug.toLowerCase().trim();
  if (!isValidSlug(slug)) throw new Error(`Invalid workspace name: "${slug}".`);

  const existing = await getTenantBySlug(slug);
  if (existing && existing.status === 'active') {
    throw new Error(`Workspace "${slug}" already exists.`);
  }

  // 1. Create the database (only if we don't already have a record from a prior attempt).
  let dbUrl: string;
  if (existing) {
    dbUrl = existing.dbUrl; // resume — reuse the recorded (decrypted) URL
  } else {
    const create = input.createDatabase ?? createNeonDatabase;
    dbUrl = await create(slug);
    // 2. Register immediately (status 'provisioning') so a crash is resumable.
    await createTenantRecord({ slug, name: input.name, dbUrl, plan: input.plan });
    invalidateTenant(slug);
  }

  // 3. Run migrations against the tenant DB (NOT push). Lock-protected so this can never race
  //    a deploy-time rollout (scripts/migrate-all.ts) migrating the same DB concurrently.
  await migrateTenantDatabase(dbUrl);

  // 4. Blank slate: create ONLY the admin user (no password) + prefs. No codes, no contracts.
  const db = getDbForUrl(dbUrl);

  const email = input.adminEmail.toLowerCase().trim();
  let [admin] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (!admin) {
    [admin] = await db.insert(schema.users).values({
      email,
      fullName: input.adminName.trim(),
      role: 'admin',
      isActive: true,
      // passwordHash intentionally omitted — set via the invite flow (signup blueprint).
    }).returning({ id: schema.users.id });
    await db.insert(schema.notificationPreferences).values({ userId: admin.id });
  }

  // 5. Activate.
  await controlDb.update(tenants).set({ status: 'active', updatedAt: new Date() }).where(eq(tenants.slug, slug));
  invalidateTenant(slug);

  return { slug, adminUserId: admin.id };
}
