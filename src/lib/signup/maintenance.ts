import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { and, between, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { signups, tenants } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { raiseAlert, resolveAlert } from '@/lib/tenant/lifecycle-store';
import { countNeonProjects } from '@/lib/tenant/neon';
import {
  CONSUMED_SIGNUP_RETENTION_DAYS, NEON_PROJECT_ALERT_THRESHOLD, UNVERIFIED_SIGNUP_RETENTION_DAYS,
  VERIFIED_UNPROVISIONED_RETENTION_DAYS,
} from '@/lib/tenant/lifecycle-config';
import { signupControlsEnabled } from './controls';

/**
 * Daily signup cleanup + Neon quota (feature-plan-launch-blockers.md P5, LB-D2, LB-D5), run by the tenant-lifecycle
 * cron BEFORE the digest — and even when its tenant loop stopped early. Each step is isolated: one failing never skips
 * the others or the digest.
 *
 * Cleanup runs only with SIGNUP_CONTROLS_ENABLED (flag off → signups untouched, exactly as before). The Neon project
 * quota alert is not a retention question and always runs (when a Neon key is configured).
 */

const DAY = 86_400_000;
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * DAY);

export interface SignupMaintenanceSummary {
  cleanup: 'off' | { unverifiedDeleted: number; consumedDeleted: number; consumedKept: string[]; verifiedUnprovisionedDeleted: number } | 'failed';
  neonProjects: 'skipped' | number | 'failed';
}

export async function runSignupMaintenance(now: Date = new Date()): Promise<SignupMaintenanceSummary> {
  const summary: SignupMaintenanceSummary = { cleanup: 'off', neonProjects: 'skipped' };
  if (signupControlsEnabled()) {
    try {
      summary.cleanup = await cleanupSignups(now);
    } catch (err) {
      summary.cleanup = 'failed';
      console.error('[signup maintenance] cleanup failed:', err);
      Sentry.captureException(err);
    }
  }
  try {
    summary.neonProjects = await checkNeonQuota(now);
  } catch (err) {
    summary.neonProjects = 'failed';
    console.error('[signup maintenance] Neon quota step failed:', err);
    Sentry.captureException(err);
  }
  return summary;
}

async function cleanupSignups(now: Date) {
  // 1. Never verified (and never consumed) past 7 days.
  const unverified = await controlDb.delete(signups).where(and(
    isNull(signups.verifiedAt), isNull(signups.consumedAt), lt(signups.createdAt, daysAgo(now, UNVERIFIED_SIGNUP_RETENTION_DAYS)),
  )).returning({ id: signups.id });

  // 2. Consumed past 30 days — ONLY when the tenant row (slug + signup email) already holds the Terms version and
  //    acceptance time (LB-D5: proof of contract). Otherwise keep it and tell the founder.
  const consumed = await controlDb.select({
    id: signups.id, slug: signups.slug, tVersion: tenants.termsVersion, tAccepted: tenants.termsAcceptedAt,
  }).from(signups)
    .leftJoin(tenants, and(eq(tenants.slug, signups.slug), eq(tenants.signupEmail, signups.email)))
    .where(and(isNotNull(signups.consumedAt), lt(signups.consumedAt, daysAgo(now, CONSUMED_SIGNUP_RETENTION_DAYS))));
  const deletable = consumed.filter((r) => r.tVersion && r.tAccepted);
  const kept = consumed.filter((r) => !(r.tVersion && r.tAccepted));
  for (const r of deletable) await controlDb.delete(signups).where(eq(signups.id, r.id));
  for (const r of kept) {
    await withLockedPool((db) => raiseAlert(db, { tenantId: null, kind: 'signup-terms-not-copied', dedupKey: r.slug, detail: { slug: r.slug, signupId: r.id } }, now));
  }

  // 3. Verified but never provisioned (incl. waitlisted, IP-refused) past 30 days.
  const verifiedUnprovisioned = await controlDb.delete(signups).where(and(
    isNotNull(signups.verifiedAt), isNull(signups.consumedAt), lt(signups.verifiedAt, daysAgo(now, VERIFIED_UNPROVISIONED_RETENTION_DAYS)),
  )).returning({ id: signups.id });

  return {
    unverifiedDeleted: unverified.length,
    consumedDeleted: deletable.length,
    consumedKept: kept.map((r) => r.slug),
    verifiedUnprovisionedDeleted: verifiedUnprovisioned.length,
  };
}

async function checkNeonQuota(now: Date): Promise<number | 'skipped'> {
  if (!process.env.NEON_API_KEY) return 'skipped';
  const quota = { tenantId: null, kind: 'neon-project-quota' };
  const failed = { tenantId: null, kind: 'neon-project-quota-check-failed' };
  let count: number;
  try {
    count = await countNeonProjects();
  } catch (err) {
    // occurrences / first_seen_at on the open alert show how many consecutive days the check has failed.
    await withLockedPool((db) => raiseAlert(db, { ...failed, detail: { error: String(err instanceof Error ? err.message : err) } }, now));
    return 'skipped';
  }
  await withLockedPool(async (db) => {
    await resolveAlert(db, failed, now, 'project list succeeded');
    if (count >= NEON_PROJECT_ALERT_THRESHOLD) await raiseAlert(db, { ...quota, detail: { projects: count, threshold: NEON_PROJECT_ALERT_THRESHOLD } }, now);
    else await resolveAlert(db, quota, now, `below ${NEON_PROJECT_ALERT_THRESHOLD} projects`);
  });
  return count;
}

/** For the digest (flag on only): verified, never-provisioned signups that cleanup deletes within 3 days. */
export async function signupsDueForDeletion(now: Date = new Date()) {
  if (!signupControlsEnabled()) return [];
  return controlDb.select({ id: signups.id, slug: signups.slug, email: signups.email, verifiedAt: signups.verifiedAt, waitlistedAt: signups.waitlistedAt })
    .from(signups)
    .where(and(isNull(signups.consumedAt), between(signups.verifiedAt,
      daysAgo(now, VERIFIED_UNPROVISIONED_RETENTION_DAYS), daysAgo(now, VERIFIED_UNPROVISIONED_RETENTION_DAYS - 3))));
}

/** For the digest: signups waiting for the founder (`tenant:admin waitlist provision`). */
export async function waitlistedSignups() {
  return controlDb.select({ id: signups.id, slug: signups.slug, email: signups.email, waitlistedAt: signups.waitlistedAt })
    .from(signups)
    .where(and(isNotNull(signups.waitlistedAt), isNull(signups.consumedAt)));
}
