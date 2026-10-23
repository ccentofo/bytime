import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { and, count, eq, gte, ne } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { signups, tenants } from '@/db/control-plane/schema';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { isValidSlug } from '@/lib/tenant/slug-rules';
import { UserFacingError } from '@/lib/errors';
import { verifyTurnstile } from '@/lib/turnstile';
import { missingSignupConfig, VERIFICATION_FAILED } from '@/lib/signup/controls';
import { raiseSignupConfigMissing, recordTurnstileOutageSignal } from '@/lib/signup/signals';

/**
 * Is this workspace name free? (feature-plan-launch-blockers.md P4 §2: shared by the public checkSlugAvailable action,
 * startSignup, and the /signup/check route, which must not call each other's actions.) Read-only registry lookup.
 */
export async function checkSlugAvailableInternal(slug: string): Promise<{ available: boolean; reason?: string }> {
  if (!isValidSlug(slug)) return { available: false, reason: 'invalid' };
  const existing = await getTenantBySlug(slug);
  return existing ? { available: false, reason: 'taken' } : { available: true };
}

// ── Signup abuse controls (feature-plan-launch-blockers.md P5) — only called when SIGNUP_CONTROLS_ENABLED ──────────

/**
 * Turnstile gate shared by startSignup and resendSignupVerification. Missing production config → refuse + alert;
 * an outage-class failure counts toward the `turnstile-outage` alert; user errors only refuse. Every refusal is the
 * same generic message.
 */
export async function requireHumanSignup(token: string | undefined, ip: string): Promise<void> {
  const missing = missingSignupConfig();
  if (missing.length > 0) {
    await raiseSignupConfigMissing(missing);
    throw new UserFacingError(VERIFICATION_FAILED);
  }
  const outcome = await verifyTurnstile(token, { remoteip: ip });
  if (outcome.ok) return;
  try {
    if (outcome.kind === 'outage') await recordTurnstileOutageSignal();
    if (outcome.kind === 'config') await raiseSignupConfigMissing(['TURNSTILE_SECRET_KEY (rejected by Cloudflare)']);
  } catch (err) {
    console.error('[signup] could not record a Turnstile signal:', err);
    Sentry.captureException(err);
  }
  throw new UserFacingError(VERIFICATION_FAILED);
}

/** Verified signups from this IP hash within the window (optionally excluding one row). */
export async function verifiedSignupsFromIp(ipHash: string, since: Date, excludeId?: string): Promise<number> {
  const where = excludeId
    ? and(eq(signups.ipHash, ipHash), gte(signups.verifiedAt, since), ne(signups.id, excludeId))
    : and(eq(signups.ipHash, ipHash), gte(signups.verifiedAt, since));
  const [row] = await controlDb.select({ n: count() }).from(signups).where(where);
  return Number(row?.n ?? 0);
}

/** Tenants created (any status) since `since` — the LB-D2 daily cap counts these. */
export async function tenantsCreatedSince(since: Date): Promise<number> {
  const [row] = await controlDb.select({ n: count() }).from(tenants).where(gte(tenants.createdAt, since));
  return Number(row?.n ?? 0);
}
