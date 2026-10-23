import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { and, between, eq, isNotNull, isNull, lt, type SQL } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { opsAlerts, signups, tenants } from '@/db/control-plane/schema';
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
  capAlertsResolved: number | 'failed';
  neonProjects: 'skipped' | number | 'failed';
}

export interface SignupMaintenanceOptions {
  /**
   * Narrows every signups read/delete (audit S4: the integration test scopes cleanup to its own `test-lc-signup-*`
   * rows, so it never deletes a developer's real signup rows). Production passes nothing.
   */
  signupFilter?: SQL;
}

/**
 * Audit S1 (replaces the LB-D5 slug+email join): may a consumed signup row past its retention be deleted?
 * The tenant is matched on SLUG only (tenant rows are never hard-deleted).
 * - delete: the tenant is this signer's (signup_email = row email) AND holds the Terms version + acceptance time
 *   (proof of contract kept for the life of the account);
 * - delete: the tenant belongs to someone else (signup_email non-null and different) — this signer never got that
 *   workspace, so there is no contract to prove;
 * - keep (+ signup-terms-not-copied): the tenant lacks Terms data, its signup_email is NULL (legacy), or no tenant has
 *   the slug.
 */
export function consumedRowDecision(
  rowEmail: string,
  tenant: { signupEmail: string | null; termsVersion: string | null; termsAcceptedAt: Date | null } | null,
): 'delete' | 'keep' {
  if (!tenant || tenant.signupEmail === null) return 'keep';
  if (tenant.signupEmail.toLowerCase() !== rowEmail.toLowerCase()) return 'delete';
  return tenant.termsVersion && tenant.termsAcceptedAt ? 'delete' : 'keep';
}

export async function runSignupMaintenance(now: Date = new Date(), opts: SignupMaintenanceOptions = {}): Promise<SignupMaintenanceSummary> {
  const summary: SignupMaintenanceSummary = { cleanup: 'off', capAlertsResolved: 0, neonProjects: 'skipped' };
  try {
    summary.capAlertsResolved = await resolvePastCapAlerts(now);
  } catch (err) {
    summary.capAlertsResolved = 'failed';
    console.error('[signup maintenance] cap-alert resolution failed:', err);
    Sentry.captureException(err);
  }
  if (signupControlsEnabled()) {
    try {
      summary.cleanup = await cleanupSignups(now, opts.signupFilter);
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

/** Audit S6: `signup-cap-reached` is deduplicated per UTC day; once that day is over its alert is resolved. */
async function resolvePastCapAlerts(now: Date): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const rows = await withLockedPool((db) => db.update(opsAlerts)
    .set({ resolvedAt: now, resolutionNote: 'that UTC day is over' })
    .where(and(eq(opsAlerts.kind, 'signup-cap-reached'), isNull(opsAlerts.resolvedAt), lt(opsAlerts.dedupKey, today)))
    .returning({ id: opsAlerts.id }));
  return rows.length;
}

async function cleanupSignups(now: Date, filter?: SQL) {
  // 1. Never verified (and never consumed) past 7 days.
  const unverified = await controlDb.delete(signups).where(and(
    isNull(signups.verifiedAt), isNull(signups.consumedAt), lt(signups.createdAt, daysAgo(now, UNVERIFIED_SIGNUP_RETENTION_DAYS)), filter,
  )).returning({ id: signups.id });

  // 2. Consumed past 30 days — by consumedRowDecision (audit S1): the tenant matched on slug only.
  const consumed = await controlDb.select({
    id: signups.id, slug: signups.slug, email: signups.email,
    tSignupEmail: tenants.signupEmail, tId: tenants.id, tVersion: tenants.termsVersion, tAccepted: tenants.termsAcceptedAt,
  }).from(signups)
    .leftJoin(tenants, eq(tenants.slug, signups.slug))
    .where(and(isNotNull(signups.consumedAt), lt(signups.consumedAt, daysAgo(now, CONSUMED_SIGNUP_RETENTION_DAYS)), filter));
  const decide = (r: (typeof consumed)[number]) => consumedRowDecision(
    r.email,
    r.tId ? { signupEmail: r.tSignupEmail, termsVersion: r.tVersion, termsAcceptedAt: r.tAccepted } : null,
  );
  const deletable = consumed.filter((r) => decide(r) === 'delete');
  const kept = consumed.filter((r) => decide(r) === 'keep');
  for (const r of deletable) {
    await controlDb.delete(signups).where(eq(signups.id, r.id));
    await withLockedPool((db) => resolveAlert(db, { tenantId: null, kind: 'signup-terms-not-copied', dedupKey: r.slug }, now, 'signup row deleted'));
  }
  for (const r of kept) {
    await withLockedPool((db) => raiseAlert(db, { tenantId: null, kind: 'signup-terms-not-copied', dedupKey: r.slug, detail: { slug: r.slug, signupId: r.id } }, now));
  }

  // 3. Verified but never provisioned (incl. waitlisted, IP-refused) past 30 days.
  const verifiedUnprovisioned = await controlDb.delete(signups).where(and(
    isNotNull(signups.verifiedAt), isNull(signups.consumedAt), lt(signups.verifiedAt, daysAgo(now, VERIFIED_UNPROVISIONED_RETENTION_DAYS)), filter,
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
