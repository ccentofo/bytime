/**
 * The single naming rule for a tenant's physical database: `tenant_<slug>`, hyphens → underscores
 * (so it's a plain, unquoted Postgres identifier). Shared by Neon provisioning, the local-dev
 * fallback, and scripts/stress-isolation.ts — the stress test proves isolation by checking that
 * each tenant host reports exactly this name via `current_database()`, so all three MUST agree.
 *
 * Plain module (no 'server-only') so scripts can import it.
 */
const POSTGRES_MAX_IDENTIFIER_LENGTH = 63; // longer names are silently truncated by Postgres

export function tenantDatabaseName(slug: string): string {
  return `tenant_${slug.replace(/-/g, '_')}`.slice(0, POSTGRES_MAX_IDENTIFIER_LENGTH);
}
