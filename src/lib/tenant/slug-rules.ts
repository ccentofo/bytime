/**
 * Pure workspace-slug rules — no 'server-only', no I/O — so the apex workspace finder, the OAuth callback and
 * provisioning share one definition (feature-plan-launch-blockers.md P2). Re-exported from provision.ts.
 *
 * The backup image bundles this file too (feature-plan-control-plane-disaster.md §6.4 R4 types window projects with it),
 * so it must stay import-free: the Dockerfile COPYs exactly this one file.
 */
const RESERVED_SLUGS = new Set(['www', 'app', 'api', 'admin', 'static', 'assets', 'mail', 'support']);

/**
 * System Neon project names are `cadenzpoint-<x>`, the same shape as a workspace's project, so `<x>` is never a valid slug
 * (feature-plan-control-plane-disaster.md §6.7). The patterns mirror scripts/backup/lib/project-names.ts (§6.11); a test
 * builds each name with its builder and checks the slug part is refused here.
 */
const SYSTEM_PROJECT_SLUGS = new Set(['control-prod', 'control-staging', 'restore-tests', 'recoverable-canary']);
const SYSTEM_PROJECT_PATTERNS = [/^r-[0-9a-f]{8}-/, /^control-r\d{14}-\d+$/, /^rehearse-cp-\d{14}-\d+$/];

export function isValidSlug(slug: string): boolean {
  // DNS label: 1–63 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen.
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug)
    && !SYSTEM_PROJECT_SLUGS.has(slug) && !SYSTEM_PROJECT_PATTERNS.some((re) => re.test(slug));
}
