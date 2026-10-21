import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

type TenantDb = ReturnType<typeof drizzle<typeof schema>>;

// One pooled client per distinct tenant DB URL, reused across requests in this instance.
const pools = new Map<string, TenantDb>();

function clientFor(connectionString: string): TenantDb {
  const existing = pools.get(connectionString);
  if (existing) return existing;
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  const instance = drizzle(client, { schema });
  pools.set(connectionString, instance);
  return instance;
}

/**
 * Resolve the Drizzle client for the CURRENT request's tenant.
 * Fail-closed: throws if no/unknown/suspended tenant.
 * Import of getTenantOrThrow is lazy so test environments don't load server-only.
 */
export async function getDb(): Promise<TenantDb> {
  const { getTenantOrThrow } = await import('@/lib/tenant/context');
  const tenant = await getTenantOrThrow();
  return clientFor(tenant.dbUrl);
}

/**
 * Resolve a Drizzle client for an explicit connection string.
 * Used by auth (tenant resolved from JWT) and by provisioning/seed paths
 * that operate outside the request tenant context.
 */
export function getDbForUrl(connectionString: string): TenantDb {
  return clientFor(connectionString);
}

/**
 * Resolve a Drizzle client for the CURRENT request's tenant, tolerating every access mode
 * EXCEPT `closed`. For pre-billing-wall / security-function checks only: the login/auth path,
 * session.ts's requireAdminFresh/requireApproverFresh, and (feature-plan-terms-compliance.md
 * T3) the write-gate allowlist's security functions — password change/reset, MFA setup,
 * notification preferences. These must keep working in `read_only` and `billing_only` (a
 * suspended tenant's admin must still be able to authenticate, reach billing, and pay; a
 * read-only tenant's users must still be able to manage their own account). Do NOT use this
 * for business-data queries; use getDb() (reads) or getDbForWrite() (writes) there.
 */
export async function getDbForAuth(): Promise<TenantDb> {
  const { getTenantSlug } = await import('@/lib/tenant/context');
  const { getTenantBySlug } = await import('@/lib/tenant/registry');
  const { getTenantAccess } = await import('@/lib/tenant/lifecycle');
  const slug = await getTenantSlug();
  if (!slug) throw new Error('No tenant in request context.');
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Unknown workspace: ${slug}`);
  if (getTenantAccess(tenant, new Date()) === 'closed') {
    throw new Error('This workspace is not available.');
  }
  return clientFor(tenant.dbUrl);
}

/**
 * Resolve the Drizzle client for the CURRENT request's tenant, for a WRITE. §3.2: every
 * mutating server action must obtain its client from here, never getDb() — throws
 * WorkspaceReadOnlyError unless the access mode is `full`. Enforced by
 * src/__tests__/unit/server-action-guards.test.ts (the write-gate rule).
 */
export async function getDbForWrite(): Promise<TenantDb> {
  const { getTenantForWrite } = await import('@/lib/tenant/context');
  const tenant = await getTenantForWrite();
  return clientFor(tenant.dbUrl);
}
