/**
 * Per-tenant step of scripts/migrate-all.ts (feature-plan-launch-blockers.md P6 §8). Pure — database and Neon calls
 * are injected — so the rules are unit-testable.
 *
 * `deleting` tenants are migrated too: a deletion run can be abandoned and resumed, and a `deleting` tenant that is
 * restored goes back into service. One whose database is already gone (past deletion step 5, tombstone pending) is
 * skipped ONLY on a confirmed absence — Neon 404 for its project, or no pg_database row on a local/shared server.
 * Anything else (DNS hiccup, timeout) stays FAILED, as for every other tenant.
 */

export type AbsenceCheck = { absent: true } | { absent: false; note?: string };

/** FAILED detail when a `deleting` tenant's Neon project can't be checked because the key is missing (audit A11). */
export const NEON_KEY_MISSING_NOTE = 'NEON_API_KEY missing — cannot confirm deletion';

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
  /**
   * `absent: true` only when the tenant's database is CONFIRMED gone. Must never throw (errors → not confirmed). A
   * `note` replaces the FAILED detail when absence couldn't even be checked (e.g. no Neon key — audit A11).
   */
  confirmedAbsent(tenant: TenantToMigrate, url: string): Promise<AbsenceCheck>;
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
    if (tenant.status === 'deleting') {
      const check = await deps.confirmedAbsent(tenant, url);
      if (check.absent) return { outcome: 'skipped', detail: 'database deleted' };
      if (check.note) return { outcome: 'FAILED', detail: check.note };
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
    /** Is NEON_API_KEY set in this process? Without it a Neon project's absence can't be checked (audit A11). */
    hasNeonKey: boolean;
  },
): Promise<AbsenceCheck> {
  try {
    const db = probes.classify(url, { neonProjectId: tenant.neonProjectId });
    if (db.kind === 'neon-project' && !probes.hasNeonKey) return { absent: false, note: NEON_KEY_MISSING_NOTE };
    const exists = db.kind === 'neon-project'
      ? await probes.neonProjectExists(db.projectId)
      : await probes.databaseExists(db.adminUrl, db.dbName);
    return exists === false ? { absent: true } : { absent: false };
  } catch {
    return { absent: false };
  }
}
