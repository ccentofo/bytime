import { describeDatabaseUrl, isLoopbackUrl } from './target';

/**
 * feature-plan-launch-blockers.md P6 §5: `provision:tenant` without NEON_API_KEY creates the tenant database on the
 * admin server — refuse unless the admin URL actually used (DEV_TENANT_ADMIN_DATABASE_URL ?? CONTROL_PLANE_DATABASE_URL)
 * is loopback. Returns the refusal message, or null when provisioning may proceed.
 */
export function provisionWithoutNeonRefusal(env: Record<string, string | undefined>, adminUrl: string): string | null {
  if (env.NEON_API_KEY) return null;
  if (isLoopbackUrl(adminUrl)) return null;
  return `NEON_API_KEY is not set, so provisioning would create the tenant database on ${describeDatabaseUrl(adminUrl)} — `
    + 'a non-local server. Set NEON_API_KEY (production) or point DEV_TENANT_ADMIN_DATABASE_URL at a local Postgres.';
}
