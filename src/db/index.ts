import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

type TenantDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Client types that make the write gate a COMPILE-time rule (feature-plan-terms-compliance-fixes.md §5.1):
 * - `ReadDb` (from getDb) has no insert/update/delete/transaction/execute, so writing through a read client
 *   doesn't compile. Raw reads use `readSql` below.
 * - `WriteDb` (from getDbForWrite, only in `full` mode) and `AuthDb` (from getDbForAuth, credential functions
 *   that must work in read_only/billing_only) are branded so a read client can't be passed where a writer
 *   expects one.
 * - `DbTx` is a transaction; it can only be opened from a WriteDb/AuthDb (ReadDb has no `.transaction`).
 */
export type ReadDb = Omit<TenantDb, 'insert' | 'update' | 'delete' | 'transaction' | 'execute'>;
export type WriteDb = TenantDb & { readonly __brand: 'WriteDb' };
export type AuthDb = TenantDb & { readonly __brand: 'AuthDb' };
export type DbTx = Parameters<Parameters<TenantDb['transaction']>[0]>[0];
/** Anything that can perform a gated tenant write: a WriteDb or a transaction opened from one. */
export type TenantWriter = WriteDb | DbTx;

// One pooled client per distinct tenant DB URL, reused across requests in this instance.
const pools = new Map<string, TenantDb>();

function clientFor(connectionString: string): TenantDb {
  // A deleted tenant's record carries an empty URL; never let postgres() fall back to PG* env defaults.
  if (!connectionString) throw new Error('No database URL for this workspace.');
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
export async function getDb(): Promise<ReadDb> {
  const { getTenantOrThrow } = await import('@/lib/tenant/context');
  const tenant = await getTenantOrThrow();
  return clientFor(tenant.dbUrl);
}

/** A raw read-only SQL query on the request tenant's database (ReadDb has no `execute`). */
export async function readSql<T extends Record<string, unknown>>(query: import('drizzle-orm').SQL): Promise<T[]> {
  const { getTenantOrThrow } = await import('@/lib/tenant/context');
  const tenant = await getTenantOrThrow();
  // A READ ONLY transaction: Postgres itself rejects any write, so raw SQL here can never bypass the write gate.
  return clientFor(tenant.dbUrl).transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return (await tx.execute(query)) as unknown as T[];
  });
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
export async function getDbForAuth(): Promise<AuthDb> {
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
  return clientFor(tenant.dbUrl) as AuthDb;
}

/**
 * Resolve the Drizzle client for the CURRENT request's tenant, for a WRITE. §3.2: every
 * mutating server action must obtain its client from here, never getDb() — throws
 * WorkspaceReadOnlyError unless the access mode is `full`. Enforced by
 * src/__tests__/unit/server-action-guards.test.ts (the write-gate rule).
 */
export async function getDbForWrite(): Promise<WriteDb> {
  const { getTenantForWrite } = await import('@/lib/tenant/context');
  const tenant = await getTenantForWrite();
  return clientFor(tenant.dbUrl) as WriteDb;
}
