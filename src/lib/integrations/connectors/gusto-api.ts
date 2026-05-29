import { db } from '@/db';
import { integrationConnections } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '@/lib/encryption';

// ---------------------------------------------------------------------------
// Gusto API Configuration
// ---------------------------------------------------------------------------

const GUSTO_DEMO_BASE = 'https://api.gusto-demo.com';
const GUSTO_PRODUCTION_BASE = 'https://api.gusto.com';
const GUSTO_AUTH_URL_DEMO = 'https://api.gusto-demo.com/oauth/authorize';
const GUSTO_AUTH_URL_PROD = 'https://api.gusto.com/oauth/authorize';
const GUSTO_TOKEN_URL_DEMO = 'https://api.gusto-demo.com/oauth/token';
const GUSTO_TOKEN_URL_PROD = 'https://api.gusto.com/oauth/token';

const isProduction = process.env.GUSTO_ENVIRONMENT === 'production';
const GUSTO_BASE_URL = isProduction ? GUSTO_PRODUCTION_BASE : GUSTO_DEMO_BASE;
const GUSTO_AUTH_URL = isProduction ? GUSTO_AUTH_URL_PROD : GUSTO_AUTH_URL_DEMO;
const GUSTO_TOKEN_URL = isProduction ? GUSTO_TOKEN_URL_PROD : GUSTO_TOKEN_URL_DEMO;

function getGustoCredentials() {
  const clientId = process.env.GUSTO_CLIENT_ID;
  const clientSecret = process.env.GUSTO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET must be set in environment variables.');
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// OAuth Helpers
// ---------------------------------------------------------------------------

/**
 * Build the Gusto OAuth authorization URL.
 */
export function getGustoAuthUrl(state?: string): string {
  const { clientId } = getGustoCredentials();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const redirectUri = `${appUrl}/api/integrations/callback/gusto`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: state ?? 'bytime_gusto_connect',
  });

  return `${GUSTO_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeGustoCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  companyUuid?: string;
  resourceOwnerType?: string;
}> {
  const { clientId, clientSecret } = getGustoCredentials();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const redirectUri = `${appUrl}/api/integrations/callback/gusto`;

  const response = await fetch(GUSTO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gusto token exchange failed: ${response.status} ${errorBody}`);
  }

  const data = await response.json();

  // Log the full token response to discover company UUID location
  console.log('Gusto token exchange full response keys:', Object.keys(data));
  console.log('Gusto token exchange full response:', JSON.stringify(data, null, 2));

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 7200, // Gusto tokens expire in 2 hours
    // Pass through any company-related fields from the token response
    companyUuid: data.company_uuid ?? data.resource_owner_id ?? data.company_id ?? undefined,
    resourceOwnerType: data.resource_owner_type ?? undefined,
  };
}

/**
 * Refresh an expired access token.
 */
export async function refreshGustoToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { clientId, clientSecret } = getGustoCredentials();

  const response = await fetch(GUSTO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gusto token refresh failed: ${response.status} ${errorBody}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 7200,
  };
}

/**
 * Ensure the access token for a connection is valid.
 * If expired or about to expire (within 5 minutes), refresh it.
 */
export async function ensureValidGustoToken(connectionId: string): Promise<string> {
  const [connection] = await db
    .select({
      accessTokenEncrypted: integrationConnections.accessTokenEncrypted,
      refreshTokenEncrypted: integrationConnections.refreshTokenEncrypted,
      tokenExpiresAt: integrationConnections.tokenExpiresAt,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection?.accessTokenEncrypted || !connection?.refreshTokenEncrypted) {
    throw new Error('Connection has no stored tokens.');
  }

  const expiresAt = connection.tokenExpiresAt ? new Date(connection.tokenExpiresAt).getTime() : 0;
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;

  if (expiresAt > fiveMinutesFromNow) {
    return decrypt(connection.accessTokenEncrypted);
  }

  const currentRefreshToken = decrypt(connection.refreshTokenEncrypted);
  const newTokens = await refreshGustoToken(currentRefreshToken);

  await db.update(integrationConnections)
    .set({
      accessTokenEncrypted: encrypt(newTokens.accessToken),
      refreshTokenEncrypted: encrypt(newTokens.refreshToken),
      tokenExpiresAt: new Date(Date.now() + newTokens.expiresIn * 1000),
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, connectionId));

  return newTokens.accessToken;
}

// ---------------------------------------------------------------------------
// Gusto Data API
// ---------------------------------------------------------------------------

// Gusto requires a versioned API header on all requests.
// See: https://docs.gusto.com/embedded-payroll/docs/versioning
const GUSTO_API_VERSION = '2026-02-01';

/**
 * Standard headers for all Gusto API requests.
 */
function gustoHeaders(accessToken: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/json',
    'X-Gusto-API-Version': GUSTO_API_VERSION,
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  return headers;
}

/**
 * Generic Gusto API GET request (raw — returns unknown for flexible parsing).
 */
export async function gustoGetRaw(accessToken: string, path: string): Promise<unknown> {
  const response = await fetch(`${GUSTO_BASE_URL}${path}`, {
    headers: gustoHeaders(accessToken),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gusto API GET ${path} failed: ${response.status} ${errorBody}`);
  }

  return response.json();
}

/**
 * Generic Gusto API GET request.
 */
async function gustoGet<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`${GUSTO_BASE_URL}${path}`, {
    headers: gustoHeaders(accessToken),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gusto API GET ${path} failed: ${response.status} ${errorBody}`);
  }

  return response.json();
}

/**
 * Generic Gusto API POST request.
 */
async function gustoPost<T>(accessToken: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${GUSTO_BASE_URL}${path}`, {
    method: 'POST',
    headers: gustoHeaders(accessToken, 'application/json'),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gusto API POST ${path} failed: ${response.status} ${errorBody}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Entity Fetchers
// ---------------------------------------------------------------------------

export interface GustoEmployee {
  uuid: string;
  first_name: string;
  last_name: string;
  email: string | null;
  terminated: boolean;
}

export interface GustoCompany {
  uuid: string;
  name: string;
}

/**
 * Get the current authenticated user's company info.
 */
export async function fetchGustoCurrentUser(accessToken: string): Promise<{
  companyId: string;
  companyName: string;
}> {
  const me = await gustoGet<{ email: string; roles: Array<{ type: string; company: { uuid: string; name: string } }> }>(
    accessToken,
    '/v1/me'
  );

  // Find the first company role
  const companyRole = me.roles?.find((r) => r.company);
  if (!companyRole) {
    throw new Error('No company found for the authenticated Gusto user.');
  }

  return {
    companyId: companyRole.company.uuid,
    companyName: companyRole.company.name,
  };
}

/**
 * Fetch all active employees from Gusto.
 */
export async function fetchGustoEmployees(
  accessToken: string,
  companyId: string
): Promise<Array<{ id: string; name: string; email?: string }>> {
  const employees = await gustoGet<GustoEmployee[]>(
    accessToken,
    `/v1/companies/${companyId}/employees`
  );

  return employees
    .filter((e) => !e.terminated)
    .map((e) => ({
      id: e.uuid,
      name: `${e.first_name} ${e.last_name}`.trim(),
      email: e.email ?? undefined,
    }));
}

/**
 * Get company details.
 */
export async function fetchGustoCompanyInfo(
  accessToken: string,
  companyId: string
): Promise<{ companyName: string }> {
  try {
    const company = await gustoGet<GustoCompany>(accessToken, `/v1/companies/${companyId}`);
    return { companyName: company.name };
  } catch {
    return { companyName: 'Unknown Company' };
  }
}
