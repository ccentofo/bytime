/**
 * Founder tooling for tenant lifecycle fields (feature-plan-terms-compliance.md T4).
 * Talks to the control plane directly — bypasses the app entirely.
 *
 * Usage:
 *   tsx scripts/tenant-admin.ts show <slug>
 *   tsx scripts/tenant-admin.ts extend-trial <slug> <days> --yes
 *   tsx scripts/tenant-admin.ts end-trial <slug> --yes
 *
 * `show` is read-only and needs no flag. `extend-trial`/`end-trial` print the before/after state
 * and refuse to write without `--yes`.
 *
 * Required env (loaded from .env.local then .env): CONTROL_PLANE_DATABASE_URL
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { desc, eq } from 'drizzle-orm';
import { tenants, tenantNotices } from '../src/db/control-plane/schema';

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function printTenant(label: string, t: typeof tenants.$inferSelect) {
  console.log(`${label}:`);
  console.log(`  status:                 ${t.status}`);
  console.log(`  plan:                   ${t.plan}`);
  console.log(`  subscription_status:    ${t.subscriptionStatus ?? '(none)'}`);
  console.log(`  trial_ends_at:          ${t.trialEndsAt?.toISOString() ?? '(none)'}`);
  console.log(`  past_due_since:         ${t.pastDueSince?.toISOString() ?? '(none)'}`);
  console.log(`  suspended_at:           ${t.suspendedAt?.toISOString() ?? '(none)'}`);
  console.log(`  subscription_ended_at:  ${t.subscriptionEndedAt?.toISOString() ?? '(none)'}`);
  console.log(`  deletion_scheduled_for: ${t.deletionScheduledFor?.toISOString() ?? '(none)'}`);
  console.log(`  deleted_at:             ${t.deletedAt?.toISOString() ?? '(none)'}`);
}

async function main() {
  const [command, slug, ...rest] = process.argv.slice(2);
  if (!command || !slug) {
    fail('Usage: tenant-admin.ts <show|extend-trial|end-trial> <slug> [args] [--yes]');
  }

  const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');

  const sql = postgres(controlUrl!, { max: 1 });
  const db = drizzle(sql);

  try {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (!tenant) fail(`No tenant with slug "${slug}".`);

    if (command === 'show') {
      printTenant(`Tenant "${slug}"`, tenant!);
      const notices = await db
        .select({ kind: tenantNotices.kind, scheduledFor: tenantNotices.scheduledFor, sentAt: tenantNotices.sentAt })
        .from(tenantNotices)
        .where(eq(tenantNotices.tenantId, tenant!.id))
        .orderBy(desc(tenantNotices.scheduledFor));
      console.log(`\nNotices (${notices.length}):`);
      for (const n of notices) {
        console.log(`  ${n.kind.padEnd(24)} scheduled ${n.scheduledFor.toISOString()}  ${n.sentAt ? `sent ${n.sentAt.toISOString()}` : 'NOT SENT'}`);
      }
      process.exit(0);
    }

    const yes = rest.includes('--yes');

    if (command === 'extend-trial') {
      const days = Number(rest.find((a) => !a.startsWith('--')));
      if (!Number.isFinite(days) || days <= 0) fail('extend-trial requires a positive number of days.');
      const base = tenant!.trialEndsAt ?? new Date();
      const newTrialEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

      printTenant('Before', tenant!);
      console.log(`\nWould set trial_ends_at → ${newTrialEndsAt.toISOString()}`);
      if (!yes) {
        console.log('\nDry run — pass --yes to apply.');
        process.exit(0);
      }
      const [updated] = await db.update(tenants)
        .set({ trialEndsAt: newTrialEndsAt, updatedAt: new Date() })
        .where(eq(tenants.id, tenant!.id))
        .returning();
      console.log('');
      printTenant('After', updated!);
      process.exit(0);
    }

    if (command === 'end-trial') {
      printTenant('Before', tenant!);
      const now = new Date();
      console.log(`\nWould set trial_ends_at → ${now.toISOString()} (trial ends immediately; the next lifecycle cron run applies the consequences)`);
      if (!yes) {
        console.log('\nDry run — pass --yes to apply.');
        process.exit(0);
      }
      const [updated] = await db.update(tenants)
        .set({ trialEndsAt: now, updatedAt: new Date() })
        .where(eq(tenants.id, tenant!.id))
        .returning();
      console.log('');
      printTenant('After', updated!);
      process.exit(0);
    }

    fail(`Unknown command "${command}". Use show, extend-trial, or end-trial.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('tenant-admin failed:', err?.message ?? err);
  process.exit(1);
});
