/**
 * Per-tenant step of scripts/migrate-all.ts (feature-plan-launch-blockers.md P6 §8). Pure — database and Neon calls
 * are injected — so the rules are unit-testable.
 *
 * `deleting` tenants are migrated too: a deletion run can be abandoned and resumed, and a `deleting` tenant that is
 * restored goes back into service. One whose database is already gone (past deletion step 5, tombstone pending) is
 * skipped ONLY on a confirmed absence — Neon 404 for its project, or no pg_database row on a local/shared server.
 * Anything else (DNS hiccup, timeout) stays FAILED, as for every other tenant.
 */

export const MIGRATABLE_TENANT_STATUSES = ['active', 'suspended', 'provisioning', 'deleting'] as const;

export type TenantOutcome = 'migrated' | 'up-to-date' | 'pending' | 'current' | 'skipped' | 'FAILED';

export interface TenantToMigrate {
  slug: string;
  status: string;
  neonProjectId: string | null;
}

export interface TenantMigrationDeps {
  pendingCount(url: string): Promise<number>;
  migrate(url: string): Promise<void>;
  /** True only when the tenant's database is CONFIRMED gone. Must never throw (treat errors as "not confirmed"). */
  confirmedAbsent(tenant: TenantToMigrate, url: string): Promise<boolean>;
  redact(message: string): string;
}

export async function migrateOneTenant(
  tenant: TenantToMigrate,
  url: string,
  check: boolean,
  deps: TenantMigrationDeps,
): Promise<{ outcome: TenantOutcome; detail: string }> {
  try {
    if (check) {
      const pending = await deps.pendingCount(url);
      return { outcome: pending > 0 ? 'pending' : 'current', detail: pending > 0 ? `${pending} migration(s)` : '' };
    }
    const pendingBefore = await deps.pendingCount(url);
    await deps.migrate(url);
    return { outcome: pendingBefore > 0 ? 'migrated' : 'up-to-date', detail: '' };
  } catch (err) {
    if (tenant.status === 'deleting' && await deps.confirmedAbsent(tenant, url)) {
      return { outcome: 'skipped', detail: 'database deleted' };
    }
    return { outcome: 'FAILED', detail: deps.redact(String((err as Error)?.message ?? err)) };
  }
}

/**
 * Confirmed-absence check for a `deleting` tenant's database, reusing tenant deletion's own classification
 * (src/lib/tenant/delete-tenant.ts classifyDatabase) and existence probes (src/lib/tenant/neon.ts). Any error —
 * an unclassifiable URL, a Neon 5xx, an unreachable server — means "not confirmed" (false).
 */
export async function isTenantDatabaseConfirmedAbsent(
  tenant: TenantToMigrate,
  url: string,
  probes: {
    classify(url: string, row: { neonProjectId: string | null }): { kind: 'neon-project'; projectId: string } | { kind: 'local' | 'shared-project'; adminUrl: string; dbName: string };
    neonProjectExists(projectId: string): Promise<boolean>;
    databaseExists(adminUrl: string, dbName: string): Promise<boolean>;
  },
): Promise<boolean> {
  try {
    const db = probes.classify(url, { neonProjectId: tenant.neonProjectId });
    const exists = db.kind === 'neon-project'
      ? await probes.neonProjectExists(db.projectId)
      : await probes.databaseExists(db.adminUrl, db.dbName);
    return exists === false;
  } catch {
    return false;
  }
}
