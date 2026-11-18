/**
 * The disaster task's control-plane SQL (feature-plan-disaster-restore.md §6.4, §6.7): plain SQL with explicit columns,
 * as 3b's image does (a migration on other columns can't break the image). The switch takes the app's own tenant lock,
 * `pg_advisory_xact_lock(hashtext('tenant:' || id))` (src/db/control-plane/locked.ts:63), so it serialises with every
 * lifecycle write and with `tenant:delete`.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export interface TenantFacts {
  id: string;
  slug: string;
  status: string;
  dbUrlEncrypted: string | null;
  neonProjectId: string | null;
  deletionScheduledFor: Date | null;
}

const TENANT_COLUMNS = `id::text AS id, slug, status::text AS status, db_url_encrypted AS "dbUrlEncrypted",
  neon_project_id AS "neonProjectId", deletion_scheduled_for AS "deletionScheduledFor"`;

export async function loadTenant(sql: Sql, id: string): Promise<TenantFacts | null> {
  const [row] = await sql.unsafe(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [id]) as unknown as TenantFacts[];
  return row ?? null;
}

/** Live tenants (provisioning/active/suspended with a URL), by id: the targets of `all-lost` and the network/control pool. */
export async function liveTenants(sql: Sql): Promise<TenantFacts[]> {
  return await sql.unsafe(`SELECT ${TENANT_COLUMNS} FROM tenants
    WHERE status IN ('provisioning', 'active', 'suspended') AND db_url_encrypted IS NOT NULL ORDER BY id`) as unknown as TenantFacts[];
}

/** Every non-deleted tenant other than `id` (the switch guards: no other workspace may hold the new project or host). */
export async function otherTenants(sql: Sql, id: string): Promise<Array<{ id: string; dbUrlEncrypted: string | null; neonProjectId: string | null }>> {
  return sql<Array<{ id: string; dbUrlEncrypted: string | null; neonProjectId: string | null }>>`
    SELECT id::text AS id, db_url_encrypted AS "dbUrlEncrypted", neon_project_id AS "neonProjectId" FROM tenants
    WHERE id <> ${id} AND status <> 'deleted'`;
}

export interface ActionRow {
  runId: string;
  tenantId: string | null;
  kind: 'proof' | 'rebuild' | 'rehearse';
  status: string;
  projectName?: string | null;
  newProjectId?: string | null;
  oldProjectId?: string | null;
  backupKey?: string | null;
  backupStartedAt?: Date | null;
  detail?: string | null;
}

/**
 * Rows written in the same millisecond would tie on `at` (and "the newest row" would then depend on a random uuid), so
 * within this process each row's time is strictly after the previous one when they are less than a second apart.
 */
let lastAtMs = 0;
export function monotonicAt(at: Date): Date {
  let ms = at.getTime();
  if (ms <= lastAtMs && lastAtMs - ms < 1_000) ms = lastAtMs + 1;
  lastAtMs = Math.max(lastAtMs, ms);
  return new Date(ms);
}

export async function appendAction(sql: Sql | Tx, r: ActionRow, atIn: Date): Promise<void> {
  const at = monotonicAt(atIn);
  await sql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, project_name, new_project_id, old_project_id, backup_key, backup_started_at, detail, at)
    VALUES (${r.runId}, ${r.tenantId}, ${r.kind}, ${r.status}, ${r.projectName ?? null}, ${r.newProjectId ?? null}, ${r.oldProjectId ?? null},
      ${r.backupKey ?? null}, ${r.backupStartedAt ?? null}, ${r.detail ? r.detail.slice(0, 2000) : null}, ${at})`;
}

/** Raw-SQL alert raise, ON CONFLICT on ops_alerts_open_unique as lifecycle-store.ts raiseAlert does. Global scope. */
export async function raiseGlobalAlert(sql: Sql | Tx, o: { kind: string; dedupKey: string; detail: Record<string, unknown> }, at: Date): Promise<void> {
  await sql`INSERT INTO ops_alerts (scope, tenant_id, kind, dedup_key, detail, first_seen_at, last_seen_at)
    VALUES ('global', NULL, ${o.kind}, ${o.dedupKey}, ${sql.json(o.detail as postgres.JSONValue)}, ${at}, ${at})
    ON CONFLICT (scope, kind, dedup_key) WHERE resolved_at IS NULL
    DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, occurrences = ops_alerts.occurrences + 1, detail = EXCLUDED.detail`;
}

// ---- override evidence (§6.4 step 2) ------------------------------------------------------------------------------

export interface EvidenceFacts {
  /** The newest `linked` row or `database-rebuilt` audit: evidence must be newer. */
  rebuiltAt: Date | null;
  /** The newest `refused:reachable` proof: evidence must be newer. */
  reachableAt: Date | null;
  /** The newest 3b `ok` backup's finished_at. */
  lastOkAt: Date | null;
  /** The newest `reachable-again` proof. */
  reachableAgainAt: Date | null;
  /** `observed-unreachable` proofs for this original, newest first. */
  observations: Array<{ at: Date }>;
  /** 3b `failed` rows in the last 26 hours: run, time and error summary. */
  failedBackups: Array<{ runId: string; at: Date; error: string | null }>;
}

export async function evidenceFacts(sql: Sql, tenantId: string, oldProjectId: string, now: Date): Promise<EvidenceFacts> {
  const since26h = new Date(now.getTime() - 26 * 3600_000);
  const [m] = await sql<Array<{ linkedAt: Date | null; auditAt: Date | null; reachableAt: Date | null; lastOkAt: Date | null; againAt: Date | null }>>`
    SELECT
      (SELECT max(at) FROM disaster_actions WHERE tenant_id = ${tenantId} AND kind = 'rebuild' AND status = 'linked') AS "linkedAt",
      (SELECT max(created_at) FROM tenant_audit_events WHERE tenant_id = ${tenantId} AND kind = 'database-rebuilt') AS "auditAt",
      (SELECT max(at) FROM disaster_actions WHERE tenant_id = ${tenantId} AND kind = 'proof' AND status = 'refused:reachable') AS "reachableAt",
      (SELECT max(finished_at) FROM database_backups WHERE tenant_id = ${tenantId} AND status = 'ok') AS "lastOkAt",
      (SELECT max(at) FROM disaster_actions WHERE tenant_id = ${tenantId} AND kind = 'proof' AND status = 'reachable-again') AS "againAt"`;
  const observations = await sql<Array<{ at: Date }>>`SELECT at FROM disaster_actions
    WHERE tenant_id = ${tenantId} AND kind = 'proof' AND status = 'observed-unreachable' AND old_project_id = ${oldProjectId} ORDER BY at DESC`;
  const failedBackups = await sql<Array<{ runId: string; at: Date; error: string | null }>>`SELECT run_id AS "runId", started_at AS at, error
    FROM database_backups WHERE tenant_id = ${tenantId} AND status = 'failed' AND started_at >= ${since26h} ORDER BY started_at`;
  const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : a ?? b);
  return { rebuiltAt: latest(m.linkedAt, m.auditAt), reachableAt: m.reachableAt, lastOkAt: m.lastOkAt, reachableAgainAt: m.againAt, observations, failedBackups };
}

// ---- backup candidates (§6.4 step 4) ------------------------------------------------------------------------------

export interface OkRow {
  key: string;
  sha256: string;
  rowCounts: Record<string, unknown> | null;
  startedAt: Date;
}

export async function okBackupRows(sql: Sql, tenantId: string): Promise<OkRow[]> {
  return sql<OkRow[]>`SELECT s3_key AS key, sha256, row_counts AS "rowCounts", started_at AS "startedAt" FROM database_backups
    WHERE tenant_id = ${tenantId} AND status = 'ok' AND s3_key IS NOT NULL ORDER BY started_at DESC`;
}

// ---- the switch and the locked re-read (§6.4 steps 8 and 10) --------------------------------------------------------

export class ChangedMeanwhile extends Error {
  constructor() { super('changed-meanwhile'); this.name = 'ChangedMeanwhile'; }
}

export const LOCK_TIMEOUT_SQLSTATE = '55P03';

/** Read the tenant's project id inside a transaction holding the tenant lock (waits for an in-progress switch commit). */
export async function lockedProjectId(sql: Sql, tenantId: string, lockTimeout = '30s'): Promise<string | null> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + tenantId}))`;
    const [row] = await tx<Array<{ p: string | null }>>`SELECT neon_project_id AS p FROM tenants WHERE id = ${tenantId}`;
    return row?.p ?? null;
  }) as Promise<string | null>;
}
