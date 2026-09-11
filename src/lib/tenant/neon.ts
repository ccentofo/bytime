import 'server-only';
import postgres from 'postgres';

/**
 * Create a dedicated Neon PROJECT for a tenant and return its connection string.
 *
 * Implementation: project-per-tenant (matches the legacy provision-customer.sh pattern).
 * This is the strongest isolation model — each tenant gets their own Neon project with
 * its own compute, storage, and credentials. The Neon API v2 project-creation response
 * includes connection_uris[0].connection_uri, so no multi-step construction is needed.
 *
 * If NEON_PROJECT_ID is set, the caller intended the shared-project / per-database model
 * instead. That approach requires separately fetching the endpoint host + role password
 * to construct a URI, which is more complex. Use the project-per-tenant approach below
 * unless you specifically need to share compute across tenants.
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

  // Create a new Neon project per tenant. The response includes connection_uris
  // which gives a ready-to-use postgres:// connection string.
  // Ref: https://api-docs.neon.tech/reference/createproject
  const res = await fetch('https://console.neon.tech/api/v2/projects', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      project: {
        name: `bytime-${slug}`,
        pg_version: 16,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Neon project creation failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  // Neon API v2 project creation response includes connection_uris[].connection_uri
  const connectionUri: string | undefined = data.connection_uris?.[0]?.connection_uri;
  if (!connectionUri) {
    throw new Error(
      `Neon project created (${data.project?.id}) but no connection_uri in response. ` +
      `Response keys: ${Object.keys(data).join(', ')}`
    );
  }

  return connectionUri;
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

  const dbName = `tenant_${slug.replace(/-/g, '_')}`; // hyphens aren't valid unquoted identifiers

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
