import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { getTenantBySlug, createTenantRecord, invalidateTenant } from '@/lib/tenant/registry';
import { getDbForUrl } from '@/db';
import * as schema from '@/db/schema';
import { createNeonDatabase } from './neon';
import { migrateTenantDatabase } from './migrate-tenant';
import { canonicalTimeZone } from '@/lib/calendar-date';
import { TRIAL_DAYS } from './lifecycle-config';
import { addDays } from './lifecycle';
import { withTenantLock } from '@/db/control-plane/locked';
import { readTenant, updateTenantGuarded } from './lifecycle-store';
import { lockUserRulesExclusive, recomputeSelfApproval } from '@/server/internal/approval-rules';

// The slug rules live in a pure module (usable outside 'server-only' code); re-exported for existing importers.
export { isValidSlug } from './slug-rules';
import { isValidSlug } from './slug-rules';

export type ProvisionInput = {
  slug: string;
  name: string;
  adminEmail: string;
  adminName: string;
  plan?: string;
  /** D8: the signer's browser IANA timezone, captured at signup. Validated; falls back to
   * workspace_settings' own column default (America/New_York) if missing or invalid. */
  timezone?: string;
  /** T9/R12: copied from the signups row — the Terms version the signer accepted, and when. */
  termsVersion?: string;
  termsAcceptedAt?: Date;
  /** Override DB creation (tests / self-hosted). Defaults to Neon. */
  createDatabase?: (slug: string) => Promise<string>;
};

export type ProvisionResult = { slug: string; adminUserId: string };

/** The workspace name belongs to an existing workspace or to another signer's in-progress provisioning. */
export class ProvisionConflictError extends Error {}

/**
 * Provision a new tenant end-to-end. Idempotent and resumable: safe to re-run for a
 * slug stuck in 'provisioning'. Throws on hard failure, leaving status='provisioning'.
 */
export async function provisionTenant(input: ProvisionInput): Promise<ProvisionResult> {
  const slug = input.slug.toLowerCase().trim();
  if (!isValidSlug(slug)) throw new Error(`Invalid workspace name: "${slug}".`);

  const email = input.adminEmail.toLowerCase().trim();
  const existing = await getTenantBySlug(slug);
  if (existing) {
    // Resume ONLY a crashed provisioning, and only by the signer who started it. Anything else (active,
    // suspended, deleting, deleted, or a different signer racing a second signup for the same name) is taken —
    // otherwise a second verify link could add its holder as an admin, or revive a suspended workspace.
    const [owner] = await controlDb.select({ signupEmail: tenants.signupEmail }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (existing.status !== 'provisioning' || !owner?.signupEmail || owner.signupEmail.toLowerCase() !== email) {
      throw new ProvisionConflictError(`Workspace "${slug}" already exists.`);
    }
  }

  // 1. Create the database (only if we don't already have a record from a prior attempt).
  let dbUrl: string;
  if (existing) {
    dbUrl = existing.dbUrl; // resume — reuse the recorded (decrypted) URL
  } else if (input.createDatabase) {
    dbUrl = await input.createDatabase(slug); // test / self-hosted override — no Neon project
    // 2. Register immediately (status 'provisioning') so a crash is resumable.
    await createTenantRecord({ slug, name: input.name, dbUrl, plan: input.plan, signupEmail: email });
    invalidateTenant(slug);
  } else {
    const created = await createNeonDatabase(slug);
    dbUrl = created.dbUrl;
    // 2. Register immediately (status 'provisioning') so a crash is resumable. T7: persist the
    // Neon project id now so deletion never has to guess it from the project name.
    await createTenantRecord({ slug, name: input.name, dbUrl, plan: input.plan, neonProjectId: created.neonProjectId, signupEmail: email });
    invalidateTenant(slug);
  }

  // 3. Run migrations against the tenant DB (NOT push). Lock-protected so this can never race
  //    a deploy-time rollout (scripts/migrate-all.ts) migrating the same DB concurrently.
  await migrateTenantDatabase(dbUrl);

  // 4. Blank slate: create ONLY the admin user (no password) + prefs. No codes, no contracts.
  const db = getDbForUrl(dbUrl);

  let [admin] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (!admin) {
    admin = await db.transaction(async (tx) => {
      await lockUserRulesExclusive(tx); // F1: first statement, before any row lock
      const [created] = await tx.insert(schema.users).values({
        email,
        fullName: input.adminName.trim(),
        role: 'admin',
        isActive: true,
        // passwordHash intentionally omitted — set via the invite flow (signup blueprint).
      }).returning({ id: schema.users.id });
      await tx.insert(schema.notificationPreferences).values({ userId: created.id });
      // feature-plan-certified-outputs.md C2 (CO-D19, ruling Q5): the baseline self_approval/enabled row, written only
      // when this admin is inserted (a resumed provisioning finds the admin and never writes a second one).
      await recomputeSelfApproval(tx, created.id, 'workspace created');
      return created;
    });
  }

  // D8: seed workspace_settings with the signer's captured timezone (validated; the column's
  // own default covers a missing/invalid value). Migration 0011 seeds this row too, so this is
  // an upsert, not a bare insert — safe to re-run on a resumed provision.
  const timezone = canonicalTimeZone(input.timezone) ?? undefined;
  if (timezone) {
    await db.insert(schema.workspaceSettings).values({ id: 1, timezone })
      .onConflictDoUpdate({ target: schema.workspaceSettings.id, set: { timezone, updatedAt: new Date() } });
  }

  // 5. Activate. T4: a brand-new trial tenant gets trial_ends_at here — resuming a crashed
  // provision must not reset it, so only set it when it isn't already there.
  // §4.1: a lifecycle-fact write, so it takes the tenant lock and bumps lifecycle_version.
  const plan = input.plan ?? existing?.plan ?? 'trial';
  const [{ id: tenantId }] = await controlDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  await withTenantLock(tenantId, async (tx) => {
    const row = await readTenant(tx, tenantId);
    if (!row) throw new Error(`Tenant ${slug} disappeared during provisioning.`);
    const now = new Date();
    await updateTenantGuarded(tx, row, {
      status: 'active',
      signupEmail: email,
      ...(plan === 'trial' && !row.trialEndsAt ? { trialEndsAt: addDays(now, TRIAL_DAYS) } : {}),
      // T9/R12: copied from the signups row; omitted (not set to null) when absent, so a resumed
      // provision never clears an already-recorded acceptance.
      ...(input.termsVersion ? { termsVersion: input.termsVersion } : {}),
      ...(input.termsAcceptedAt ? { termsAcceptedAt: input.termsAcceptedAt } : {}),
    }, now, eq(tenants.status, 'provisioning')); // never re-activates a suspended/deleting workspace
  });
  invalidateTenant(slug);

  return { slug, adminUserId: admin.id };
}
