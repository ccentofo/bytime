'use server';

import crypto from 'crypto';
import dayjs from 'dayjs';
import { headers } from 'next/headers';
import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { checkSlugAvailableInternal } from '@/server/internal/signup';
import { sendSignupVerifyEmail } from '@/lib/email/send-signup';
import { scheduleEmail } from '@/lib/email/schedule';
import { apexBaseUrl } from '@/lib/tenant/host';
import { slugify } from '@/lib/tenant/slugify';
import { checkRateLimit } from '@/lib/rate-limit';
import { canonicalTimeZone } from '@/lib/calendar-date';
import { TERMS_VERSION } from '@/lib/tenant/lifecycle-config';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

const VERIFY_EXPIRY_HOURS = 24;

export async function checkSlugAvailable(slug: string): Promise<{ available: boolean; reason?: string }> {
  return checkSlugAvailableInternal(slug);
}

export async function startSignup(input: {
  companyName: string;
  email: string;
  slug?: string;
  timezone?: string;
  termsAccepted: boolean;
}): Promise<ActionResult<void>> {
  return userAction(async () => {
    // R12: identity isn't established yet at signup, but acceptance is still a real, required gate —
    // reject server-side regardless of what the client's button disabling did or didn't allow.
    if (input.termsAccepted !== true) {
      throw new UserFacingError('You must agree to the Terms of Service and Privacy Policy.');
    }

    // IP-based rate limit: 8 signups per hour per IP to prevent abuse and spam provisioning.
    const h = await headers();
    const ip = h.get('x-forwarded-for')?.split(',')[0].trim() ?? h.get('x-real-ip') ?? 'unknown';
    const rateResult = checkRateLimit(`signup:${ip}`, 8, 60 * 60 * 1000);
    if (!rateResult.allowed) {
      throw new UserFacingError('Too many signup attempts. Please try again later.');
    }

    const email = input.email.toLowerCase().trim();
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
    });

    // Signup verification links to the APEX — the workspace host doesn't exist yet.
    const apexUrl = apexBaseUrl();
    const verifyUrl = `${apexUrl}/signup/verify?token=${rawToken}&email=${encodeURIComponent(email)}`;
    const companyName = input.companyName.trim();
    scheduleEmail('signup-verify', () => sendSignupVerifyEmail({ email, companyName, verifyUrl, appUrl: apexUrl }));

    // Dev convenience: surface the verify link in the server log so the flow is testable
    // locally without a configured email provider. Never logs in production.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[signup] verify link for ${email}: ${verifyUrl}`);
    }

    return;
  });
}
