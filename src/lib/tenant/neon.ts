import 'server-only';
import postgres from 'postgres';
import { tenantDatabaseName } from './db-name';

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
 * DEV-ONLY: create a local Postgres database for a tenant and return its connection URL.
 * Used when NEON_API_KEY is absent in non-production, so signup/provisioning can be exercised
 * against local Postgres. The admin connection comes from DEV_TENANT_ADMIN_DATABASE_URL, else
 * CONTROL_PLANE_DATABASE_URL, else a local default. The slug is already validated by
 * provisionTenant (isValidSlug), so the derived identifier is safe to interpolate.
 */
async function createLocalDevDatabase(slug: string): Promise<CreatedTenantDatabase> {
  const adminUrl =
    process.env.DEV_TENANT_ADMIN_DATABASE_URL ??
    process.env.CONTROL_PLANE_DATABASE_URL ??
    'postgresql://bytime:bytime_dev@localhost:5432/bytime';

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

/**
 * T7: DEV-ONLY counterpart to deleteNeonProject — drops the local tenant_<slug> database.
 * Mirrors createLocalDevDatabase's admin-connection resolution exactly.
 */
export async function dropLocalDevDatabase(slug: string): Promise<void> {
  const adminUrl =
    process.env.DEV_TENANT_ADMIN_DATABASE_URL ??
    process.env.CONTROL_PLANE_DATABASE_URL ??
    'postgresql://bytime:bytime_dev@localhost:5432/bytime';
  const dbName = tenantDatabaseName(slug);

  const admin = postgres(adminUrl, { max: 1 });
  try {
    // Terminate other connections first — DROP DATABASE fails while any session is attached
    // (the app's own pooled client for this tenant, if still warm in this process).
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    console.log(`[tenant:delete] dropped local database ${dbName}`);
  } finally {
    await admin.end();
  }
}

/**
 * T7.4: DELETE /projects/{project_id} (Neon API v2). Returns 200 on success; treat a 404 as
 * already-deleted (idempotent). Per api-docs.neon.tech/reference/deleteproject (confirmed Oct
 * 2026): success is 200 with a ProjectResponse body; other outcomes use a generic GeneralError
 * response without a documented specific status for "already deleted" — 404 is this function's
 * own defensive choice for that case, consistent with the blueprint's "treat 404 as already
 * deleted," not something Neon's reference explicitly promises.
 *
 * A deleted project is recoverable for 7 days via POST /projects/{project_id}/recover (per
 * neon.com/docs/manage/projects, confirmed Oct 2026) — after that, deletion is permanent.
 */
export async function deleteNeonProject(projectId: string): Promise<{ alreadyDeleted: boolean }> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) throw new Error('NEON_API_KEY is not set — cannot delete a Neon project.');

  const res = await fetch(`${NEON_API_BASE}/projects/${projectId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });

  if (res.status === 404) return { alreadyDeleted: true };
  if (!res.ok) {
    throw new Error(`Neon project deletion failed for ${projectId}: ${res.status} ${await res.text()}`);
  }
  return { alreadyDeleted: false };
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
