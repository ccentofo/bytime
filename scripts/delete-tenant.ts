/**
 * Permanently delete a tenant workspace — its database and its Stripe subscription — and
 * tombstone the control-plane row (feature-plan-terms-compliance.md T7, R10).
 *
 * THIS IS IRREVERSIBLE. The tenant's database is destroyed (Neon: the project; local dev: the
 * tenant_<slug> database). Only run this against a throwaway LOCAL tenant you created for a
 * test. NEVER run it against a demo tenant (acme, globex, initech) or any remote database unless
 * you are the founder doing a real, authorized deletion.
 *
 * Usage:
 *   tsx scripts/delete-tenant.ts <slug>                                   # dry run — prints what would happen
 *   tsx scripts/delete-tenant.ts <slug> --yes                             # apply
 *   tsx scripts/delete-tenant.ts <slug> --yes --force-with-reason "<text>" # bypass the notice-timing check
 *
 * Refuses to apply unless `deletion_scheduled_for` has passed AND a 'deletion-notice' was sent at
 * least DELETION_NOTICE_DAYS (D3) days ago — both proven by rows this tool reads, not asserted.
 * `--force-with-reason` bypasses that check but still requires `--yes`, and the reason is printed
 * in the receipt as part of this run's own audit trail.
 *
 * Idempotent: running it again against an already-deleted tenant is a no-op that prints the
 * existing tombstone.
 *
 * Required env (loaded from .env.local then .env): CONTROL_PLANE_DATABASE_URL, STRIPE_SECRET_KEY
 * (if the tenant has a subscription), NEON_API_KEY (if the tenant has a neon_project_id).
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { desc, eq } from 'drizzle-orm';
import { tenants, tenantNotices } from '../src/db/control-plane/schema';
import { DELETION_NOTICE_DAYS } from '../src/lib/tenant/lifecycle-config';
import { deleteNeonProject, dropLocalDevDatabase } from '../src/lib/tenant/neon';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  const yes = args.includes('--yes');
  const forceIdx = args.indexOf('--force-with-reason');
  const forceReason = forceIdx >= 0 ? args[forceIdx + 1] : undefined;
  if (forceIdx >= 0 && !forceReason) fail('--force-with-reason requires a reason string.');

  if (!slug) fail('Usage: delete-tenant.ts <slug> [--yes] [--force-with-reason "<text>"]');

  const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');

  const sql = postgres(controlUrl!, { max: 1 });
  const db = drizzle(sql);

  try {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug!)).limit(1);
    if (!tenant) fail(`No tenant with slug "${slug}".`);

    if (tenant!.status === 'deleted') {
      console.log(`"${slug}" is already deleted. Tombstone:`);
      printReceipt(tenant!, await notices(db, tenant!.id));
      process.exit(0);
    }

    const now = new Date();
    const scheduledOk = tenant!.deletionScheduledFor !== null && tenant!.deletionScheduledFor <= now;
    const noticeRows = await notices(db, tenant!.id);
    const deletionNotice = noticeRows.find((n) => n.kind === 'deletion-notice' && n.sentAt !== null);
    const noticeOk = Boolean(
      deletionNotice?.sentAt && now.getTime() - deletionNotice.sentAt.getTime() >= DELETION_NOTICE_DAYS * MS_PER_DAY,
    );
    const eligible = scheduledOk && noticeOk;

    console.log(`Tenant: ${tenant!.slug} (${tenant!.name}), status=${tenant!.status}`);
    console.log(`  deletion_scheduled_for: ${tenant!.deletionScheduledFor?.toISOString() ?? '(not set)'} — ${scheduledOk ? 'passed' : 'NOT YET PASSED'}`);
    console.log(`  deletion-notice sent:   ${deletionNotice?.sentAt?.toISOString() ?? '(never sent)'} — ${noticeOk ? `≥${DELETION_NOTICE_DAYS}d ago` : `needs ≥${DELETION_NOTICE_DAYS}d notice`}`);

    if (!eligible && !forceReason) {
      fail(
        `Not eligible for deletion yet. Pass --force-with-reason "<text>" to override (logged in this run's receipt).`,
      );
    }
    if (forceReason) {
      console.log(`\n⚠ FORCED (bypassing eligibility check): ${forceReason}`);
    }

    console.log('\nThis will, in order:');
    console.log('  1. Set status = deleting (blocks all access immediately)');
    console.log(`  2. Cancel the Stripe subscription${tenant!.stripeSubscriptionId ? ` (${tenant!.stripeSubscriptionId})` : ' (none on file)'}`);
    console.log(`  3. Delete the database${tenant!.neonProjectId ? ` (Neon project ${tenant!.neonProjectId})` : ' (local dev database)'}`);
    console.log('  4. Tombstone the registry row (status = deleted, db_url_encrypted = null)');

    if (!yes) {
      console.log('\nDry run — pass --yes to apply.');
      process.exit(0);
    }

    // 1. Block access immediately.
    await db.update(tenants).set({ status: 'deleting', updatedAt: new Date() }).where(eq(tenants.id, tenant!.id));
    console.log('\n✓ Status set to deleting.');

    // 2. Cancel Stripe subscription (keep the customer — billing/tax records, Privacy §7).
    if (tenant!.stripeSubscriptionId) {
      try {
        const { stripe } = await import('../src/lib/billing/stripe');
        await stripe.subscriptions.cancel(tenant!.stripeSubscriptionId);
        console.log('✓ Stripe subscription canceled.');
      } catch (err) {
        console.error(`⚠ Failed to cancel Stripe subscription (continuing with deletion): ${(err as Error).message}`);
      }
    }

    // 3. Delete the database.
    if (tenant!.neonProjectId) {
      const { alreadyDeleted } = await deleteNeonProject(tenant!.neonProjectId);
      console.log(alreadyDeleted ? '✓ Neon project already deleted.' : '✓ Neon project deleted.');
    } else if (!process.env.NEON_API_KEY) {
      await dropLocalDevDatabase(slug!);
      console.log('✓ Local database dropped.');
    } else {
      console.error(
        '⚠ No neon_project_id on file and NEON_API_KEY is set — cannot determine which Neon ' +
        'project to delete. DELETE IT MANUALLY in the Neon console (look for ' +
        `"cadenzpoint-${slug}"), then re-run this script (it will skip straight to tombstoning).`,
      );
    }

    // 4. Tombstone. Slug, name, Stripe ids, dates, and tenant_notices all stay — proof of notice
    // and of deletion, and the slug stays reserved.
    const [tombstoned] = await db.update(tenants).set({
      status: 'deleted',
      deletedAt: new Date(),
      dbUrlEncrypted: null,
      updatedAt: new Date(),
    }).where(eq(tenants.id, tenant!.id)).returning();

    console.log('\n✓ Deletion complete.\n');
    printReceipt(tombstoned!, await notices(db, tenant!.id));
    process.exit(0);
  } finally {
    await sql.end();
  }
}

async function notices(db: ReturnType<typeof drizzle>, tenantId: string) {
  return db
    .select({ kind: tenantNotices.kind, scheduledFor: tenantNotices.scheduledFor, sentAt: tenantNotices.sentAt })
    .from(tenantNotices)
    .where(eq(tenantNotices.tenantId, tenantId))
    .orderBy(desc(tenantNotices.scheduledFor));
}

function printReceipt(tenant: typeof tenants.$inferSelect, noticeRows: Array<{ kind: string; scheduledFor: Date; sentAt: Date | null }>) {
  console.log('--- Deletion receipt ---');
  console.log(`  slug:                   ${tenant.slug}`);
  console.log(`  name:                   ${tenant.name}`);
  console.log(`  status:                 ${tenant.status}`);
  console.log(`  deletion_scheduled_for: ${tenant.deletionScheduledFor?.toISOString() ?? '(none)'}`);
  console.log(`  deleted_at:             ${tenant.deletedAt?.toISOString() ?? '(none)'}`);
  console.log(`  neon_project_id:        ${tenant.neonProjectId ?? '(none)'}`);
  console.log(`  notices (${noticeRows.length}):`);
  for (const n of noticeRows) {
    console.log(`    ${n.kind.padEnd(24)} scheduled ${n.scheduledFor.toISOString()}  ${n.sentAt ? `sent ${n.sentAt.toISOString()}` : 'NOT SENT'}`);
  }
}

main().catch((err) => {
  console.error('delete-tenant failed:', err?.message ?? err);
  process.exit(1);
});
