/**
 * Pure workspace-slug rules — no 'server-only', no I/O — so the apex workspace finder, the OAuth callback and
 * provisioning share one definition (feature-plan-launch-blockers.md P2). Re-exported from provision.ts.
 */
const RESERVED_SLUGS = new Set(['www', 'app', 'api', 'admin', 'static', 'assets', 'mail', 'support']);

export function isValidSlug(slug: string): boolean {
  // DNS label: 1–63 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen.
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug);
}
