'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { isValidSlug } from '@/lib/tenant/slug-rules';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { checkSlugLookupRateLimit, getClientIpFromHeaders } from '@/lib/rate-limit';

/**
 * Apex "Find your workspace" (feature-plan-launch-blockers.md P2): sends a visitor who landed on the apex
 * /login or /forgot-password to the same page on their workspace host.
 *
 * Open-redirect safety: `target` must be EXACTLY '/login' or '/forgot-password' and the slug must pass
 * isValidSlug, so the destination is always `https://<valid-label>.<APP_ROOT_DOMAIN><fixed path>` — never a
 * caller-chosen host (e.g. `acme.root@evil.com`). The URL is built server-side, where APP_ROOT_DOMAIN exists.
 *
 * Disclosure: "No workspace with that name" reveals whether a slug exists — no more than the public
 * signup availability check already does, and the two share one rate-limit budget (checkSlugLookupRateLimit).
 */
export async function goToWorkspace(slug: string, target: string): Promise<{ error: string }> {
  if (target !== '/login' && target !== '/forgot-password') {
    return { error: 'Invalid request.' };
  }
  const normalized = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  if (!isValidSlug(normalized)) {
    return { error: 'Enter your workspace name: letters, numbers and hyphens (for example, acme).' };
  }

  const limit = checkSlugLookupRateLimit(getClientIpFromHeaders(await headers()));
  if (!limit.allowed) {
    return { error: 'Too many attempts. Please wait a minute and try again.' };
  }

  const tenant = await getTenantBySlug(normalized);
  if (!tenant) {
    return { error: 'No workspace with that name.' };
  }

  // Outside any try/catch: redirect() works by throwing.
  redirect(`${tenantBaseUrl(normalized)}${target}`);
}
