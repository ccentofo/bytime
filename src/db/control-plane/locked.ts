import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

/**
 * Locked sections for tenant lifecycle writes (feature-plan-terms-compliance-fixes.md §2 latency budget, §4.3
 * rule 3). A DEDICATED small pool, separate from the request-path pool, so a burst of webhook events for one
 * tenant can never starve page loads or jwtCallback. `prepare: false` because of Neon's transaction pooler,
 * where `pg_advisory_xact_lock` (transaction-scoped) still works.
 */
type ControlDb = ReturnType<typeof drizzle<typeof schema>>;
export type ControlTx = Parameters<Parameters<ControlDb['transaction']>[0]>[0];

let lockedDb: ControlDb | undefined;
function getLockedDb(): ControlDb {
  if (!lockedDb) {
    const url = process.env.CONTROL_PLANE_DATABASE_URL;
    if (!url) throw new Error('CONTROL_PLANE_DATABASE_URL is not set. See .env.example.');
    lockedDb = drizzle(postgres(url, { max: 3, prepare: false }), { schema });
  }
  return lockedDb;
}

/** Thrown when the tenant lock can't be taken within the budget. Webhooks map it to 503 (Stripe retries). */
export class TenantLockTimeoutError extends Error {
  constructor(tenantId: string) {
    super(`Timed out waiting for the lifecycle lock of tenant ${tenantId}`);
    this.name = 'TenantLockTimeoutError';
  }
}

/** Thrown when a version-guarded update matched no row (someone else changed the tenant first). */
export class LifecycleVersionConflictError extends Error {
  constructor(tenantId: string) {
    super(`Lifecycle version conflict for tenant ${tenantId}`);
    this.name = 'LifecycleVersionConflictError';
  }
}

const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '10s';
const MAX_ATTEMPTS = 3;

function isLockTimeout(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code
    ?? (err as { code?: string })?.code;
  return code === '55P03';
}

/**
 * Run `fn` in one control-plane transaction holding the tenant's lifecycle lock. Every statement inside MUST
 * use the passed `tx` (never `controlDb`: waiting for a second pool connection while holding the lock can
 * deadlock the pool). A version conflict re-runs `fn` (it re-reads the row), at most 3 times in total.
 */
export async function withTenantLock<T>(tenantId: string, fn: (tx: ControlTx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getLockedDb().transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + tenantId}))`);
        return fn(tx);
      });
    } catch (err) {
      if (isLockTimeout(err)) throw new TenantLockTimeoutError(tenantId);
      if (err instanceof LifecycleVersionConflictError && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}

/** A plain (unlocked) transaction on the dedicated pool, for writes that are order-safe without the lock. */
export async function withLockedPool<T>(fn: (db: ControlDb) => Promise<T>): Promise<T> {
  return fn(getLockedDb());
}
