'use server';

import crypto from 'crypto';
import dayjs from 'dayjs';
import { headers } from 'next/headers';
import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { isValidSlug } from '@/lib/tenant/provision';
import { sendSignupVerifyEmail } from '@/lib/email/send-signup';
import { slugify } from '@/lib/tenant/slugify';
import { checkRateLimit } from '@/lib/rate-limit';
import { canonicalTimeZone } from '@/lib/calendar-date';

const VERIFY_EXPIRY_HOURS = 24;

export async function checkSlugAvailable(slug: string): Promise<{ available: boolean; reason?: string }> {
  if (!isValidSlug(slug)) return { available: false, reason: 'invalid' };
  const existing = await getTenantBySlug(slug);
  return existing ? { available: false, reason: 'taken' } : { available: true };
}

export async function startSignup(input: {
  companyName: string;
  email: string;
  slug?: string;
  timezone?: string;
}): Promise<{ success: boolean; error?: string }> {
  // IP-based rate limit: 8 signups per hour per IP to prevent abuse and spam provisioning.
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0].trim() ?? h.get('x-real-ip') ?? 'unknown';
  const rateResult = checkRateLimit(`signup:${ip}`, 8, 60 * 60 * 1000);
  if (!rateResult.allowed) {
    return { success: false, error: 'Too many signup attempts. Please try again later.' };
  }

  const email = input.email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: 'Please enter a valid email address.' };
  }
  const slug = (input.slug?.trim() || slugify(input.companyName));
  const avail = await checkSlugAvailable(slug);
  if (!avail.available) {
    return {
      success: false,
      error: avail.reason === 'taken'
        ? 'That workspace name is taken. Try another.'
        : 'That workspace name is not allowed. Use letters, numbers, and hyphens.',
    };
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
    expiresAt: dayjs().add(VERIFY_EXPIRY_HOURS, 'hour').toDate(),
  });

  const apexUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const verifyUrl = `${apexUrl}/signup/verify?token=${rawToken}&email=${encodeURIComponent(email)}`;
  sendSignupVerifyEmail({ email, companyName: input.companyName.trim(), verifyUrl }); // fire-and-forget

  // Dev convenience: surface the verify link in the server log so the flow is testable
  // locally without a configured email provider. Never logs in production.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[signup] verify link for ${email}: ${verifyUrl}`);
  }

  return { success: true };
}
