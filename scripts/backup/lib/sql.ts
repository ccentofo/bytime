/**
 * Control-plane access for the backup image (feature-plan-database-backups.md §6.2: plain SQL with explicit column lists,
 * so a migration on other columns can't break the image). Every client here gets a URL reduced to `sslmode` (pg-url.ts).
 */
import postgres from 'postgres';
import { clientUrl } from './pg-url';
import { FatalError } from './env';

export type Sql = postgres.Sql;

export const BACKUP_TABLES = ['database_backups', 'backup_audits', 'restore_test_runs', 'restore_test_results', 'backup_permission_checks'] as const;
export const TABLES_MISSING_MESSAGE = 'backup tables missing: run deploy-prod first';

/** A small control-plane client (queries only; locks use locks.ts). */
export function controlPlaneClient(url: string, connect: (u: string, o: postgres.Options<Record<string, postgres.PostgresType>>) => Sql = (u, o) => postgres(u, o)): Sql {
  return connect(clientUrl(url), { max: 2, connect_timeout: 30, onnotice: () => {} });
}

/** Start check: the five tables exist, else fatal (§6.2 "Deploy order"). */
export async function assertBackupTables(sql: Sql): Promise<void> {
  const rows = await sql<{ name: string }[]>`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ${sql([...BACKUP_TABLES])}`;
  if (rows.length !== BACKUP_TABLES.length) throw new FatalError(TABLES_MISSING_MESSAGE);
}

export interface TenantTarget {
  id: string;
  slug: string;
  status: string;
  dbUrlEncrypted: string;
}

/** Tenants to back up: provisioning, active or suspended with a URL, by slug (§6.4 / v4.1 §6.2 "Order"). */
export async function listTenantTargets(sql: Sql): Promise<TenantTarget[]> {
  return sql<TenantTarget[]>`SELECT id::text AS id, slug, status::text AS status, db_url_encrypted AS "dbUrlEncrypted"
    FROM tenants WHERE status IN ('provisioning', 'active', 'suspended') AND db_url_encrypted IS NOT NULL ORDER BY slug`;
}

/** The status re-read before each tenant starts (`deleting`/`deleted` → skipped). */
export async function tenantStatus(sql: Sql, id: string): Promise<string | null> {
  const [row] = await sql<{ status: string }[]>`SELECT status::text AS status FROM tenants WHERE id = ${id}`;
  return row?.status ?? null;
}

export interface BackupRow {
  tenantId: string | null;
  target: 'tenant' | 'control-plane';
  runId: string;
  status: 'ok' | 'failed';
  s3Key: string | null;
  bytes: number | null;
  sha256: string | null;
  rowCounts: Record<string, number> | null;
  serverVersion: string | null;
  pgDumpVersion: string | null;
  region: string | null;
  targetDeadlineMs: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
}

export async function insertBackupRow(sql: Sql, r: BackupRow): Promise<string> {
  const [row] = await sql<{ id: string }[]>`INSERT INTO database_backups
    (tenant_id, target, run_id, status, s3_key, bytes, sha256, row_counts, server_version, pg_dump_version, region,
     target_deadline_ms, error, started_at, finished_at)
    VALUES (${r.tenantId}, ${r.target}, ${r.runId}, ${r.status}, ${r.s3Key}, ${r.bytes}, ${r.sha256},
     ${r.rowCounts === null ? null : sql.json(r.rowCounts)}, ${r.serverVersion}, ${r.pgDumpVersion}, ${r.region},
     ${r.targetDeadlineMs}, ${r.error}, ${r.startedAt}, ${r.finishedAt})
    RETURNING id::text AS id`;
  return row.id;
}

export interface PermissionCheckRow {
  runId: string;
  role: 'backup' | 'audit' | 'restore-test';
  checkedAt: Date;
  ok: boolean;
  detail: Record<string, unknown>;
}

export async function insertPermissionCheck(sql: Sql, r: PermissionCheckRow): Promise<void> {
  await sql`INSERT INTO backup_permission_checks (run_id, role, checked_at, ok, detail)
    VALUES (${r.runId}, ${r.role}, ${r.checkedAt}, ${r.ok}, ${sql.json(r.detail as postgres.JSONValue)})`;
}
