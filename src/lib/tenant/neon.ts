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
export async function createNeonDatabase(slug: string): Promise<string> {
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

  return withHost(details.connection_uri, poolerHost);
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
async function createLocalDevDatabase(slug: string): Promise<string> {
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
  return u.toString();
}
