'use server';

import crypto from 'crypto';
import dayjs from 'dayjs';
import { headers } from 'next/headers';
import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { checkSlugAvailableInternal, requireHumanSignup, verifiedSignupsFromIp } from '@/server/internal/signup';
import { hashSignupIp, RESEND_GENERIC_RESPONSE, signupControlsEnabled, SignupConfigError, VERIFICATION_FAILED } from '@/lib/signup/controls';
import { nullExpiredSignupIpHashes, raiseSignupConfigMissing } from '@/lib/signup/signals';
import { sendSignupVerifyEmail } from '@/lib/email/send-signup';
import { scheduleEmail } from '@/lib/email/schedule';
import { apexBaseUrl } from '@/lib/tenant/host';
import { slugify } from '@/lib/tenant/slugify';
import { checkRateLimit, getClientIpFromHeaders } from '@/lib/rate-limit';
import { canonicalTimeZone } from '@/lib/calendar-date';
import { SIGNUP_PER_IP_WORKSPACES_PER_DAY, TERMS_VERSION } from '@/lib/tenant/lifecycle-config';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

const VERIFY_EXPIRY_HOURS = 24;
const TOO_MANY_FROM_NETWORK = 'Too many workspaces have been created from your network today. Please try again tomorrow.';

export async function checkSlugAvailable(slug: string): Promise<{ available: boolean; reason?: string }> {
  return checkSlugAvailableInternal(slug);
}

export async function startSignup(input: {
  companyName: string;
  email: string;
  slug?: string;
  timezone?: string;
  termsAccepted: boolean;
  /** Cloudflare Turnstile token (feature-plan-launch-blockers.md P5) — only checked when SIGNUP_CONTROLS_ENABLED. */
  turnstileToken?: string;
}): Promise<ActionResult<{ slug: string }>> {
  return userAction(async () => {
    const controls = signupControlsEnabled();

    // R12: identity isn't established yet at signup, but acceptance is still a real, required gate —
    // reject server-side regardless of what the client's button disabling did or didn't allow.
    if (input.termsAccepted !== true) {
      throw new UserFacingError('You must agree to the Terms of Service and Privacy Policy.');
    }

    const email = input.email.toLowerCase().trim();
    const h = await headers();
    const ip = getClientIpFromHeaders(h);

    let ipHash: string | null = null;
    if (controls) {
      // P5 order: Terms → lengths → Turnstile → attempt limiter → slug → per-IP workspace limit.
      const companyName = input.companyName.trim();
      if (companyName.length < 1 || companyName.length > 120) {
        throw new UserFacingError('Company name must be between 1 and 120 characters.');
      }
      if (email.length > 254) throw new UserFacingError('Please enter a valid email address.');
      await requireHumanSignup(input.turnstileToken, ip);
      try {
        ipHash = hashSignupIp(ip);
      } catch (err) {
        if (err instanceof SignupConfigError) {
          await raiseSignupConfigMissing(err.missing);
          throw new UserFacingError(VERIFICATION_FAILED);
        }
        throw err;
      }
      if (!ipHash) throw new UserFacingError(VERIFICATION_FAILED); // 'unknown' IP in production: fail closed
      // LB-D5: opportunistically drop IP hashes older than 24 h (the notice-delivery cron also does).
      await nullExpiredSignupIpHashes().catch((err) => console.error('[signup] ip_hash cleanup failed:', err));
    }

    // IP-based rate limit: 8 signups per hour per IP to prevent abuse and spam provisioning.
    const rateResult = checkRateLimit(`signup:${ip}`, 8, 60 * 60 * 1000);
    if (!rateResult.allowed) {
      throw new UserFacingError('Too many signup attempts. Please try again later.');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new UserFacingError('Please enter a valid email address.');
    }
    const slug = (input.slug?.trim() || slugify(input.companyName));
    const avail = await checkSlugAvailableInternal(slug);
    if (!avail.available) {
      throw new UserFacingError(avail.reason === 'taken'
        ? 'That workspace name is taken. Try another.'
        : 'That workspace name is not allowed. Use letters, numbers, and hyphens.');
    }

    if (ipHash && await verifiedSignupsFromIp(ipHash, dayjs().subtract(1, 'day').toDate()) >= SIGNUP_PER_IP_WORKSPACES_PER_DAY) {
      throw new UserFacingError(TOO_MANY_FROM_NETWORK);
    }

    // Mint a verification token.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const verifyTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    // D8: the signer's browser timezone, captured for the new tenant's workspace_settings at
    // provisioning. Untrusted client input — validated here, stored null (falls back to
    // workspace_settings' own column default) rather than rejecting the signup over it.
    const timezone = canonicalTimeZone(input.timezone);
    await controlDb.insert(signups).values({
      email,
      companyName: input.companyName.trim(),
      slug,
      verifyTokenHash,
      timezone,
      termsVersion: TERMS_VERSION,
      termsAcceptedAt: new Date(),
      expiresAt: dayjs().add(VERIFY_EXPIRY_HOURS, 'hour').toDate(),
      ipHash, // null unless signup controls are on — never the raw IP
    });

    scheduleVerifyEmail(email, input.companyName.trim(), rawToken);
    return { slug };
  });
}

/** Queue the verification email (after the response) — links to the APEX: the workspace host doesn't exist yet. */
function scheduleVerifyEmail(email: string, companyName: string, rawToken: string): void {
  const apexUrl = apexBaseUrl();
  const verifyUrl = `${apexUrl}/signup/verify?token=${rawToken}&email=${encodeURIComponent(email)}`;
  scheduleEmail('signup-verify', () => sendSignupVerifyEmail({ email, companyName, verifyUrl, appUrl: apexUrl }));

  // Dev convenience: surface the verify link in the server log so the flow is testable
  // locally without a configured email provider. Never logs in production.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[signup] verify link for ${email}: ${verifyUrl}`);
  }
}

/**
 * Re-send a signup's verification link (feature-plan-launch-blockers.md P5; SIGNUP_CONTROLS_ENABLED only). Turnstile
 * first; acts only on the newest PENDING row (unverified, not waitlisted, not consumed) for this email + slug that is
 * still inside its 24 h life: rotates the token (the old link dies) and keeps the expiry at most created_at + 24 h —
 * the IP hash lives 24 h. Always the same generic answer, so it can't be used to probe who signed up. Counts only
 * toward the in-memory attempt limiter, never toward the per-IP workspace limit.
 */
export async function resendSignupVerification(input: { email: string; slug: string; turnstileToken?: string }): Promise<ActionResult<{ message: string }>> {
  return userAction(async () => {
    if (!signupControlsEnabled()) return { message: RESEND_GENERIC_RESPONSE };
    const ip = getClientIpFromHeaders(await headers());
    await requireHumanSignup(input.turnstileToken, ip);
    if (!checkRateLimit(`signup:${ip}`, 8, 60 * 60 * 1000).allowed) {
      throw new UserFacingError('Too many signup attempts. Please try again later.');
    }

    const email = String(input.email ?? '').toLowerCase().trim();
    const slug = String(input.slug ?? '').trim();
    const now = new Date();
    const [row] = await controlDb.select().from(signups).where(and(
      eq(signups.email, email),
      eq(signups.slug, slug),
      isNull(signups.consumedAt),
      isNull(signups.verifiedAt),
      isNull(signups.waitlistedAt),
      gt(signups.createdAt, dayjs(now).subtract(VERIFY_EXPIRY_HOURS, 'hour').toDate()),
    )).orderBy(desc(signups.createdAt)).limit(1);
    if (!row) return { message: RESEND_GENERIC_RESPONSE };

    const rawToken = crypto.randomBytes(32).toString('hex');
    const cap = dayjs(row.createdAt).add(VERIFY_EXPIRY_HOURS, 'hour');
    const extended = dayjs(now).add(VERIFY_EXPIRY_HOURS, 'hour');
    // Audit S7: the UPDATE repeats the "still pending" predicates — a row verified, waitlisted or consumed between the
    // read and this write is left alone, and nothing is sent.
    const rotated = await controlDb.update(signups).set({
      verifyTokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: (extended.isBefore(cap) ? extended : cap).toDate(),
    }).where(and(
      eq(signups.id, row.id),
      isNull(signups.consumedAt),
      isNull(signups.verifiedAt),
      isNull(signups.waitlistedAt),
    )).returning({ id: signups.id });
    if (rotated.length === 0) return { message: RESEND_GENERIC_RESPONSE };
    scheduleVerifyEmail(email, row.companyName, rawToken);
    return { message: RESEND_GENERIC_RESPONSE };
  });
}
