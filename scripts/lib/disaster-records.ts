/**
 * migrate-all's control-plane reads and writes for the disaster deploy path (feature-plan-disaster-restore.md §6.0).
 * Plain SQL on a postgres.js client the CLI owns. Reads tolerate a missing `disaster_actions` table (42P01 → no facts):
 * the deploy that merges 3c runs before the control-plane migration that creates it.
 */
import type postgres from 'postgres';
import { DECISIVE_PROOFS, type TenantDisasterFacts } from '../backup/lib/disaster-proofs';
import type { DisasterActionInput } from './migrate-all-run';

type Sql = postgres.Sql;

/** `migrate-<YYYYMMDDTHHMMSSZ>`: the run id on every row one migrate-all run appends. */
export function migrateRunId(now: Date): string {
  return `migrate-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

const isMissingTable = (e: unknown) => (e as { code?: string })?.code === '42P01';

export async function readDisasterFacts(sql: Sql): Promise<Map<string, TenantDisasterFacts>> {
  const out = new Map<string, TenantDisasterFacts>();
  const get = (id: string) => {
    let f = out.get(id);
    if (!f) { f = { proof: null, linkedAt: null, skippedAt: null, migratedAt: null, lastOkAt: null }; out.set(id, f); }
    return f;
  };
  let actions: Array<{ tenantId: string; proofStatus: string | null; proofAt: Date | null; linkedAt: Date | null; skippedAt: Date | null; migratedAt: Date | null }>;
  try {
    actions = await sql`
      SELECT t.tenant_id::text AS "tenantId", p.status AS "proofStatus", p.at AS "proofAt",
        max(a.at) FILTER (WHERE a.kind = 'rebuild' AND a.status = 'linked') AS "linkedAt",
        max(a.at) FILTER (WHERE a.kind = 'skip' AND a.status = 'skipped') AS "skippedAt",
        max(a.at) FILTER (WHERE a.kind = 'skip' AND a.status = 'migrated') AS "migratedAt"
      FROM (SELECT DISTINCT tenant_id FROM disaster_actions WHERE tenant_id IS NOT NULL) t
      LEFT JOIN disaster_actions a ON a.tenant_id = t.tenant_id
      LEFT JOIN LATERAL (
        SELECT d.status, d.at FROM disaster_actions d
        WHERE d.tenant_id = t.tenant_id AND d.kind = 'proof' AND d.status = ANY(${[...DECISIVE_PROOFS]}::text[])
        ORDER BY d.at DESC, d.id DESC LIMIT 1
      ) p ON true
      GROUP BY t.tenant_id, p.status, p.at`;
  } catch (e) {
    if (isMissingTable(e)) return out;
    throw e;
  }
  for (const a of actions) {
    const f = get(a.tenantId);
    f.proof = a.proofStatus && a.proofAt ? { status: a.proofStatus, at: a.proofAt } : null;
    f.linkedAt = a.linkedAt;
    f.skippedAt = a.skippedAt;
    f.migratedAt = a.migratedAt;
  }
  if (out.size === 0) return out;
  const ok = await sql<Array<{ tenantId: string; lastOk: Date }>>`
    SELECT tenant_id::text AS "tenantId", max(finished_at) AS "lastOk" FROM database_backups
    WHERE status = 'ok' AND tenant_id = ANY(${[...out.keys()]}::uuid[]) GROUP BY tenant_id`;
  for (const r of ok) get(r.tenantId).lastOkAt = r.lastOk;
  return out;
}

export async function appendDisasterAction(sql: Sql, runId: string, row: DisasterActionInput): Promise<void> {
  await sql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, old_project_id, at)
    VALUES (${runId}, ${row.tenantId}, ${row.kind}, ${row.status}, ${row.oldProjectId}, clock_timestamp())`;
}
