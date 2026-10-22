import 'server-only';
import postgres from 'postgres';
import { tenantDatabaseName } from './db-name';
import { tenantDbHistoryRetentionSeconds } from './lifecycle-config';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';
// How long to wait for Neon to finish creating the project's branch/role/database/compute.
const NEON_OPERATION_TIMEOUT_MS = 120_000;
const NEON_OPERATION_POLL_MS = 1_000;

type NeonOperation = { id: string; action?: string; status: string; error?: string; retry_at?: string };
type NeonCreateProjectResponse = {
  project?: { id: string };
  operations?: NeonOperation[];
  connection_uris?: Array<{
    connection_uri: string;
    connection_parameters?: { host: string; pooler_host: string; database: string; role: string };
  }>;
};

/**
 * Create a dedicated Neon PROJECT for a tenant and return its POOLED connection string.
 *
 * Project-per-tenant: each tenant gets its own Neon project (compute, storage, credentials).
 * Request/response fields follow the Neon API v2 reference for POST /projects:
 *  - `project.region_id` from NEON_REGION_ID — keep tenants in the same region as the control
 *    plane and the Vercel functions (default iad1 ↔ aws-us-east-1). Omitted → Neon's default.
 *  - `project.branch.database_name` = tenantDatabaseName(slug) — otherwise every Neon DB is
 *    named `neondb`, which defeats scripts/stress-isolation.ts (it proves isolation by checking
 *    each host reports its own `current_database()`).
 *  - Returns the PgBouncer pooled host (`connection_parameters.pooler_host`): the app runs on
 *    serverless with `prepare: false`, built for a pooler. Migrations do NOT use this URL directly —
 *    migrateTenantDatabase() converts it back to the direct host (session advisory locks don't hold
 *    through a transaction-mode pooler).
 *  - Waits for the returned operations to finish before returning, as Neon requires before the
 *    first connection (the caller immediately connects to run migrations).
 *  - `project.history_retention_seconds` (LB-D1, feature-plan-launch-blockers.md P6): 7 days of point-in-time
 *    history unless NEON_HISTORY_RETENTION_SECONDS overrides it. Neon's own default is 1 day.
 */
export interface CreatedTenantDatabase {
  dbUrl: string;
  /** T7: persisted so deletion doesn't have to guess the project name. Null for local dev (no Neon project). */
  neonProjectId: string | null;
}

export async function createNeonDatabase(slug: string): Promise<CreatedTenantDatabase> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) {
    // Dev-only fallback: without a Neon key, create a local Postgres database so the full
    // signup → provision → onboarding flow is testable offline. NEVER used in production.
    if (process.env.NODE_ENV !== 'production') {
      return createLocalDevDatabase(slug);
    }
    throw new Error('NEON_API_KEY is not set — cannot create tenant database.');
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const regionId = process.env.NEON_REGION_ID;

  const res = await fetch(`${NEON_API_BASE}/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project: {
        name: `cadenzpoint-${slug}`,
        pg_version: 16,
        ...(regionId ? { region_id: regionId } : {}),
        branch: { database_name: tenantDatabaseName(slug) },
        history_retention_seconds: tenantDbHistoryRetentionSeconds(),
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Neon project creation failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as NeonCreateProjectResponse;
  const projectId = data.project?.id;
  const details = data.connection_uris?.[0];
  const poolerHost = details?.connection_parameters?.pooler_host;
  if (!projectId || !details?.connection_uri || !poolerHost) {
    throw new Error(
      `Neon project created (${projectId ?? 'unknown id'}) but the response is missing ` +
      `connection_uri/pooler_host. Response keys: ${Object.keys(data).join(', ')}`
    );
  }

  await waitForNeonOperations(projectId, (data.operations ?? []).map((op) => op.id), headers);

  return { dbUrl: withHost(details.connection_uri, poolerHost), neonProjectId: projectId };
}

/** Poll each operation until it finishes. `failed` with a `retry_at` is still being retried by Neon. */
async function waitForNeonOperations(projectId: string, operationIds: string[], headers: Record<string, string>) {
  const deadline = Date.now() + NEON_OPERATION_TIMEOUT_MS;
  for (const operationId of operationIds) {
    for (;;) {
      const res = await fetch(`${NEON_API_BASE}/projects/${projectId}/operations/${operationId}`, { headers });
      if (!res.ok) {
        throw new Error(`Neon operation lookup failed for project ${projectId}: ${res.status} ${await res.text()}`);
      }
      const { operation } = (await res.json()) as { operation: NeonOperation };

      if (operation.status === 'finished' || operation.status === 'skipped') break;
      const terminalFailure =
        operation.status === 'error' ||
        operation.status === 'cancelled' ||
        (operation.status === 'failed' && !operation.retry_at);
      if (terminalFailure) {
        throw new Error(
          `Neon project ${projectId} setup failed (${operation.action ?? 'operation'} ${operation.status}` +
          `${operation.error ? `: ${operation.error}` : ''}). Delete this project in the Neon console before retrying.`
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for Neon project ${projectId} to become ready. ` +
          `Delete this project in the Neon console before retrying.`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, NEON_OPERATION_POLL_MS));
    }
  }
}

/** Swap the host of a postgres:// URL, keeping credentials, database, and query params (e.g. sslmode). */
function withHost(connectionUri: string, host: string): string {
  const url = new URL(connectionUri);
  url.hostname = host;
  return url.toString();
}

/**
 * The admin connection createLocalDevDatabase actually uses (DEV_TENANT_ADMIN_DATABASE_URL takes precedence over
 * CONTROL_PLANE_DATABASE_URL). Exported so `provision:tenant` checks the SAME URL before running without a Neon key.
 */
export function localDevAdminUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DEV_TENANT_ADMIN_DATABASE_URL ?? env.CONTROL_PLANE_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime';
}

/**
 * DEV-ONLY: create a local Postgres database for a tenant and return its connection URL.
 * Used when NEON_API_KEY is absent in non-production, so signup/provisioning can be exercised
 * against local Postgres. The admin connection comes from DEV_TENANT_ADMIN_DATABASE_URL, else
 * CONTROL_PLANE_DATABASE_URL, else a local default. The slug is already validated by
 * provisionTenant (isValidSlug), so the derived identifier is safe to interpolate.
 */
async function createLocalDevDatabase(slug: string): Promise<CreatedTenantDatabase> {
  const adminUrl = localDevAdminUrl();

  const dbName = tenantDatabaseName(slug); // same naming rule as production (see db-name.ts)

  const admin = postgres(adminUrl, { max: 1 });
  try {
    // CREATE DATABASE cannot run inside a transaction — use a simple unsafe query.
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    console.log(`[provision:dev] created local database ${dbName}`);
  } catch (err: any) {
    if (err?.code === '42P04') {
      console.log(`[provision:dev] local database ${dbName} already exists — reusing`);
    } else {
      throw err;
    }
  } finally {
    await admin.end();
  }

  // Build the tenant URL by swapping the database name on the admin connection.
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return { dbUrl: u.toString(), neonProjectId: null };
}

/** Neon endpoint host without the PgBouncer `-pooler` suffix on its first label. */
export function directNeonHost(host: string): string {
  const [first, ...rest] = host.split('.');
  return [first.replace(/-pooler$/, ''), ...rest].join('.');
}

/**
 * §5.3 step 5 (Neon): delete a dedicated tenant project only after proving it is the right one.
 * Preflight `GET /projects/{id}` and `GET /projects/{id}/endpoints`: an endpoint host must equal the tenant
 * URL's host (minus `-pooler`), and none may equal the control plane's. Then `DELETE` and confirm `GET` → 404.
 * A 404 at preflight means a previous run already deleted it (accepted on resume).
 *
 * Neon keeps a deleted project recoverable for 7 days (POST /projects/{id}/recover, neon.com/docs/manage/projects).
 */
export async function deleteNeonProjectVerified(input: {
  projectId: string;
  tenantHost: string;
  controlPlaneHost: string;
}): Promise<{ alreadyDeleted: boolean }> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) throw new Error('NEON_API_KEY is not set — cannot delete a Neon project.');
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const base = `${NEON_API_BASE}/projects/${encodeURIComponent(input.projectId)}`;

  const project = await fetch(base, { headers });
  if (project.status === 404) return { alreadyDeleted: true };
  if (!project.ok) throw new Error(`Neon project lookup failed: ${project.status} ${await project.text()}`);

  const eps = await fetch(`${base}/endpoints`, { headers });
  if (!eps.ok) throw new Error(`Neon endpoint lookup failed: ${eps.status} ${await eps.text()}`);
  const hosts = ((await eps.json()) as { endpoints?: Array<{ host: string }> }).endpoints?.map((e) => directNeonHost(e.host)) ?? [];
  const tenantHost = directNeonHost(input.tenantHost);
  const controlHost = directNeonHost(input.controlPlaneHost);
  if (!hosts.includes(tenantHost)) {
    throw new Error(`Refusing: Neon project ${input.projectId} has no endpoint ${tenantHost} (has: ${hosts.join(', ') || 'none'}).`);
  }
  if (hosts.includes(controlHost)) {
    throw new Error(`Refusing: Neon project ${input.projectId} hosts the CONTROL PLANE (${controlHost}).`);
  }

  const del = await fetch(base, { method: 'DELETE', headers });
  if (!del.ok && del.status !== 404) throw new Error(`Neon project deletion failed: ${del.status} ${await del.text()}`);

  for (let i = 0; i < 30; i++) {
    const check = await fetch(base, { headers });
    if (check.status === 404) return { alreadyDeleted: false };
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Neon project ${input.projectId} still exists 30 s after DELETE — re-run to confirm.`);
}

/** §5.3 step 2 (first run): does the Neon project exist? 404 → false; any other failure throws (never "absent"). */
export async function neonProjectExists(projectId: string): Promise<boolean> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) throw new Error('NEON_API_KEY is not set — cannot verify the Neon project.');
  const res = await fetch(`${NEON_API_BASE}/projects/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Neon project lookup failed: ${res.status} ${await res.text()}`);
  return true;
}

/** §5.3 step 2 (first run): does the database exist on that server? */
export async function databaseExists(adminUrl: string, dbName: string): Promise<boolean> {
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  try {
    return (await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`).length > 0;
  } finally {
    await admin.end();
  }
}

/**
 * §5.3 step 5 (local dev, or a database inside the control plane's Neon project): DROP the database named in
 * the tenant URL, WITH (FORCE) so pooled app connections can't block it, connecting with `adminUrl` to another
 * database on the same server. Confirms via pg_database. Callers have already refused protected names.
 */
export async function dropDatabaseVerified(adminUrl: string, dbName: string): Promise<{ alreadyDeleted: boolean }> {
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error(`Refusing to drop an unexpected database name: ${dbName}`);
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  try {
    const before = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (before.length === 0) return { alreadyDeleted: true };
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    const after = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (after.length > 0) throw new Error(`Database ${dbName} still exists after DROP.`);
    return { alreadyDeleted: false };
  } finally {
    await admin.end();
  }
}

/**
 * T7: look up an existing project by its CadenzPoint name (`cadenzpoint-<slug>`), for backfilling
 * `neon_project_id` on tenants created before it was persisted at provisioning time. Uses the
 * `search` query param (partial match on name or id, per api-docs.neon.tech/reference/listprojects)
 * and then exact-matches the name client-side, since `search` is substring, not exact.
 */
export async function findNeonProjectIdByName(name: string): Promise<string | null> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) throw new Error('NEON_API_KEY is not set — cannot look up Neon projects.');

  const res = await fetch(`${NEON_API_BASE}/projects?search=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Neon project lookup failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as { projects?: Array<{ id: string; name: string }> };
  const match = (data.projects ?? []).find((p) => p.name === name);
  return match?.id ?? null;
}

/**
 * LB-D1 backfill (feature-plan-launch-blockers.md P6): read a project's `history_retention_seconds`. 404 → 'not-found'
 * (the caller decides whether that is a confirmed absence); any other failure throws.
 */
export async function getNeonHistoryRetention(projectId: string): Promise<number | 'not-found'> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) throw new Error('NEON_API_KEY is not set — cannot read Neon projects.');
  const res = await fetch(`${NEON_API_BASE}/projects/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (res.status === 404) return 'not-found';
  if (!res.ok) throw new Error(`Neon project lookup failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { project?: { history_retention_seconds?: number } };
  return data.project?.history_retention_seconds ?? 0;
}

/** LB-D1 backfill: `PATCH /projects/{id}` with `project.history_retention_seconds`. 404 → 'not-found'; else throws. */
export async function setNeonHistoryRetention(projectId: string, seconds: number): Promise<'updated' | 'not-found'> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) throw new Error('NEON_API_KEY is not set — cannot update Neon projects.');
  const res = await fetch(`${NEON_API_BASE}/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ project: { history_retention_seconds: seconds } }),
  });
  if (res.status === 404) return 'not-found';
  if (!res.ok) throw new Error(`Neon retention update failed: ${res.status} ${await res.text()}`);
  return 'updated';
}
