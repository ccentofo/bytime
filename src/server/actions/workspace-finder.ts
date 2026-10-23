'use server';

import { headers } from 'next/headers';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { isValidSlug } from '@/lib/tenant/slug-rules';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { checkSlugLookupRateLimit, getClientIpFromHeaders } from '@/lib/rate-limit';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

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
 *
 * Returns the URL instead of redirect()ing (launch-blockers audit A4): Next rejects the client's promise on a
 * cross-origin server-action redirect before hard-navigating, so the form showed an error on every success. The
 * client navigates with window.location.assign(url).
 */
export async function goToWorkspace(slug: string, target: string): Promise<ActionResult<{ url: string }>> {
  return userAction(async () => {
    if (target !== '/login' && target !== '/forgot-password') {
      throw new UserFacingError('Invalid request.');
    }
    const normalized = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
    if (!isValidSlug(normalized)) {
      throw new UserFacingError('Enter your workspace name: letters, numbers and hyphens (for example, acme).');
    }

    const limit = checkSlugLookupRateLimit(getClientIpFromHeaders(await headers()));
    if (!limit.allowed) {
      throw new UserFacingError('Too many attempts. Please wait a minute and try again.');
    }

    const tenant = await getTenantBySlug(normalized);
    if (!tenant) {
      throw new UserFacingError('No workspace with that name.', 'not_found');
    }

    return { url: `${tenantBaseUrl(normalized)}${target}` };
  });
}
