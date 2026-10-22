import 'server-only';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { isValidSlug } from '@/lib/tenant/slug-rules';

/**
 * Is this workspace name free? (feature-plan-launch-blockers.md P4 §2: shared by the public checkSlugAvailable action,
 * startSignup, and the /signup/check route, which must not call each other's actions.) Read-only registry lookup.
 */
export async function checkSlugAvailableInternal(slug: string): Promise<{ available: boolean; reason?: string }> {
  if (!isValidSlug(slug)) return { available: false, reason: 'invalid' };
  const existing = await getTenantBySlug(slug);
  return existing ? { available: false, reason: 'taken' } : { available: true };
}
