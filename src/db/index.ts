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
 * Resolve a Drizzle client for the CURRENT request's tenant, tolerating suspended tenants.
 * ONLY for the login/auth path — suspended admins must be able to authenticate so they can
 * reach the billing wall and pay. Do NOT use this in data paths; use getDb() there.
 */
export async function getDbForAuth(): Promise<TenantDb> {
  const { getTenantSlug } = await import('@/lib/tenant/context');
  const { getTenantBySlug } = await import('@/lib/tenant/registry');
  const slug = await getTenantSlug();
  if (!slug) throw new Error('No tenant in request context.');
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Unknown workspace: ${slug}`);
  // Allow active and suspended — login must work so the admin can reach billing
  if (tenant.status === 'deleting' || tenant.status === 'provisioning') {
    throw new Error('This workspace is not available.');
  }
  return clientFor(tenant.dbUrl);
}
