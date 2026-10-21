/**
 * One-off backfill: set `trial_ends_at` (and `signup_email`) for existing trial tenants created
 * before feature-plan-terms-compliance.md shipped.
 *
 * feature-plan-terms-compliance.md T1 / D1: `trial_ends_at = max(created_at + TRIAL_DAYS,
 * now + TRIAL_BACKFILL_MIN_DAYS)` — a tenant already mid-trial when this runs gets at least
 * TRIAL_BACKFILL_MIN_DAYS days from the backfill time, so nobody flips to read-only without
 * warning on the day this ships.
 *
 * Idempotent: only touches tenants where `trial_ends_at IS NULL`, so re-running is a no-op.
 * `signup_email` is filled from the matching consumed `signups` row (by slug) when present and
 * not already set — best-effort, never blocks the trial_ends_at backfill.
 *
 * Usage:
 *   tsx scripts/backfill-trial-dates.ts          # apply
 *   tsx scripts/backfill-trial-dates.ts --check  # report what would change, apply nothing
 *
 * Required env (loaded from .env.local then .env): CONTROL_PLANE_DATABASE_URL
 *
 * Run in staging and production immediately after deploying the T1 migration (see
 * PRODUCTION-DEPLOY.md).
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { tenants, signups } from '../src/db/control-plane/schema';
import { TRIAL_DAYS, TRIAL_BACKFILL_MIN_DAYS } from '../src/lib/tenant/lifecycle-config';

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const check = process.argv.includes('--check');

  const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlUrl) fail('CONTROL_PLANE_DATABASE_URL is not set (checked .env.local and .env).');

  const sql = postgres(controlUrl!, { max: 1 });
  const db = drizzle(sql);

  try {
    const now = new Date();
    const minBackfillFloor = new Date(now.getTime() + TRIAL_BACKFILL_MIN_DAYS * 24 * 60 * 60 * 1000);

    // Only trial-plan tenants with no Stripe subscription and no trial_ends_at yet.
    const candidates = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        createdAt: tenants.createdAt,
        signupEmail: tenants.signupEmail,
      })
      .from(tenants)
      .where(and(
        eq(tenants.plan, 'trial'),
        isNull(tenants.stripeSubscriptionId),
        isNull(tenants.trialEndsAt),
      ));

    if (candidates.length === 0) {
      console.log('✓ No trial tenants need backfilling — nothing to do.');
      process.exit(0);
    }

    console.log(`${check ? 'Would backfill' : 'Backfilling'} ${candidates.length} tenant(s):\n`);

    for (const t of candidates) {
      const fromCreation = new Date(t.createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
      const trialEndsAt = fromCreation > minBackfillFloor ? fromCreation : minBackfillFloor;

      let signupEmail = t.signupEmail;
      if (!signupEmail) {
        const [match] = await db
          .select({ email: signups.email })
          .from(signups)
          .where(and(eq(signups.slug, t.slug), isNotNull(signups.consumedAt)))
          .limit(1);
        signupEmail = match?.email ?? null;
      }

      console.log(`  ${t.slug}: trial_ends_at → ${trialEndsAt.toISOString()}${signupEmail ? `, signup_email → ${signupEmail}` : ''}`);

      if (!check) {
        await db.update(tenants)
          .set({ trialEndsAt, signupEmail: signupEmail ?? t.signupEmail, updatedAt: new Date() })
          .where(eq(tenants.id, t.id));
      }
    }

    console.log(`\n${check ? 'Dry run complete — no changes applied.' : '✓ Backfill complete.'}`);
    process.exit(0);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('backfill-trial-dates failed:', err?.message ?? err);
  process.exit(1);
});
