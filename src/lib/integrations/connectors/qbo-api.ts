import { getDb, getDbForWrite } from '@/db';
import { integrationConnections } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { decrypt, encrypt } from '@/lib/encryption';
import { UserFacingError } from '@/lib/errors';
import { connectionExpiredError, providerHttpError, providerRefreshError } from '../provider-errors';

// ---------------------------------------------------------------------------
// QBO API Configuration
// ---------------------------------------------------------------------------

const QBO_SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const QBO_PRODUCTION_BASE = 'https://quickbooks.api.intuit.com';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

// Use sandbox for development, production for deployed instances
const QBO_BASE_URL = process.env.QBO_ENVIRONMENT === 'production'
  ? QBO_PRODUCTION_BASE
  : QBO_SANDBOX_BASE;

function getClientCredentials() {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set in environment variables.');
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// OAuth Helpers
// ---------------------------------------------------------------------------

/**
 * Build the QBO OAuth authorization URL.
 */
export function getQBOAuthUrl(state: string): string {
  const { clientId } = getClientCredentials();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const redirectUri = `${appUrl}/api/integrations/callback/quickbooks_online`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state, // signed, single-use (see src/lib/integrations/oauth-state.ts)
  });

  return `${QBO_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeQBOCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  realmId?: string;
}> {
  const { clientId, clientSecret } = getClientCredentials();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const redirectUri = `${appUrl}/api/integrations/callback/quickbooks_online`;

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QBO token exchange failed: ${response.status} ${errorBody}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

/** feature-plan-launch-hardening.md H6: how long a token refresh may take before it's abandoned. */
const REFRESH_TIMEOUT_MS = 15_000;
export const QBO_NO_RESPONSE_MESSAGE = 'QuickBooks didn’t respond. Try again in a minute.';

/**
 * Refresh an expired access token using the refresh token.
 *
 * H6: the request (and reading its body) is bounded by a 15 s timeout. A timeout (`TimeoutError`) or a network failure
 * (`TypeError` from fetch) becomes "QuickBooks didn't respond…"; HTTP error responses keep the providerRefreshError
 * mapping (400/401 → reconnect). Intuit rotates the refresh token about once a day, and the previous value then expires,
 * so callers must store exactly what this returns (ensureValidToken does, under a lock).
 */
export async function refreshQBOToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { clientId, clientSecret } = getClientCredentials();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  let data: { access_token: string; refresh_token: string; expires_in?: number };
  try {
    const response = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });

    if (!response.ok) throw await providerRefreshError('QuickBooks', response); // audit R9

    data = await response.json();
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || error instanceof TypeError) throw new UserFacingError(QBO_NO_RESPONSE_MESSAGE);
    throw error;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

const TOKEN_COLUMNS = {
  provider: integrationConnections.provider,
  isActive: integrationConnections.isActive,
  accessTokenEncrypted: integrationConnections.accessTokenEncrypted,
  refreshTokenEncrypted: integrationConnections.refreshTokenEncrypted,
  tokenExpiresAt: integrationConnections.tokenExpiresAt,
};
type TokenRow = {
  provider: string;
  isActive: boolean;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
};
type UsableTokenRow = TokenRow & { accessTokenEncrypted: string; refreshTokenEncrypted: string };

/** An active QuickBooks connection with both tokens stored. Anything else (a Gusto id included) → reconnect. */
function usable(row: TokenRow | undefined): row is UsableTokenRow {
  return !!row && row.provider === 'quickbooks_online' && row.isActive && !!row.accessTokenEncrypted && !!row.refreshTokenEncrypted;
}

/** The access token is good for more than 5 more minutes. */
function stillValid(row: TokenRow): boolean {
  const expiresAt = row.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : 0;
  return expiresAt > Date.now() + 5 * 60 * 1000;
}

/**
 * Ensure the access token for a QuickBooks connection is valid; refresh it if it expires within 5 minutes. Returns the
 * valid access token.
 *
 * feature-plan-launch-hardening.md H6 — one refresh at a time per connection:
 * - fast path (no lock): an active QuickBooks row whose token is still valid → that token. Not QuickBooks, inactive, or
 *   no tokens → connectionExpiredError (a Gusto id never gets a token handed to Intuit);
 * - refresh path: the write client first (read-only mode throws before Intuit is called), then ONE transaction under
 *   pg_advisory_xact_lock(hashtext('integration-token:'||id)) that re-reads the row. Another request may have refreshed
 *   while this one waited (→ its token, no refresh), or a reconnect / disconnect may have won (→ reconnect error, no
 *   write). Otherwise it refreshes with the RE-READ refresh token and stores the new pair by compare-and-swap on the
 *   ciphertext it read (AND is_active): under READ COMMITTED the WHERE is re-checked against the latest committed row,
 *   so a reconnect (same row, new tokens) or disconnect that committed during the Intuit call updates 0 rows → the
 *   reconnect's tokens win and this throws connectionExpiredError.
 * Lock order: only this lock, never with another family; reconnect takes integration-connection:{provider} and then
 * row locks, and this transaction holds no row lock until its final update — so no deadlock.
 */
export async function ensureValidToken(connectionId: string): Promise<string> {
  const db = await getDb();
  const [connection] = await db.select(TOKEN_COLUMNS).from(integrationConnections).where(eq(integrationConnections.id, connectionId));

  if (!usable(connection)) throw connectionExpiredError('QuickBooks'); // audit R9: no stored tokens → reconnect
  if (stillValid(connection)) return decrypt(connection.accessTokenEncrypted);

  // Get the write client BEFORE refreshing: in a read-only workspace this throws here, before the
  // provider rotates the refresh token, so the stored token is never invalidated and lost.
  const writeDb = await getDbForWrite();
  return writeDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'integration-token:' + connectionId}))`);
    const [row] = await tx.select(TOKEN_COLUMNS).from(integrationConnections).where(eq(integrationConnections.id, connectionId));
    if (!usable(row)) throw connectionExpiredError('QuickBooks'); // a disconnect / reconnect won
    if (stillValid(row)) return decrypt(row.accessTokenEncrypted); // refreshed by another request while this one waited

    const newTokens = await refreshQBOToken(decrypt(row.refreshTokenEncrypted));
    const now = new Date();
    const stored = await tx.update(integrationConnections)
      .set({
        accessTokenEncrypted: encrypt(newTokens.accessToken),
        refreshTokenEncrypted: encrypt(newTokens.refreshToken),
        tokenExpiresAt: new Date(now.getTime() + newTokens.expiresIn * 1000),
        updatedAt: now,
      })
      .where(and(
        eq(integrationConnections.id, connectionId),
        eq(integrationConnections.isActive, true),
        eq(integrationConnections.refreshTokenEncrypted, row.refreshTokenEncrypted),
      ))
      .returning({ id: integrationConnections.id });
    if (stored.length === 0) throw connectionExpiredError('QuickBooks'); // a reconnect / disconnect committed meanwhile
    return newTokens.accessToken;
  });
}

// ---------------------------------------------------------------------------
// QBO Data API
// ---------------------------------------------------------------------------

interface QBOQueryResponse<T> {
  QueryResponse: Record<string, T[] | number | undefined>;
}

/**
 * Execute a QBO query (SQL-like syntax).
 */
async function qboQuery<T>(
  accessToken: string,
  realmId: string,
  query: string
): Promise<T[]> {
  const url = `${QBO_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=73`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) throw await providerHttpError('QuickBooks', 'query', response); // audit R9: 401 → reconnect

  const data = await response.json();
  const queryResponse = data.QueryResponse;

  // The response key varies by entity type — find the first array
  for (const key of Object.keys(queryResponse)) {
    if (Array.isArray(queryResponse[key])) {
      return queryResponse[key] as T[];
    }
  }

  return [];
}

/**
 * Create a QBO entity.
 */
async function qboCreate<T>(
  accessToken: string,
  realmId: string,
  entityType: string,
  data: Record<string, unknown>
): Promise<T> {
  const url = `${QBO_BASE_URL}/v3/company/${realmId}/${entityType}?minorversion=73`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) throw await providerHttpError('QuickBooks', `create ${entityType}`, response); // audit R9

  const result = await response.json();
  return result[entityType.charAt(0).toUpperCase() + entityType.slice(1)] as T;
}

/**
 * Execute a QBO batch operation (up to 30 items).
 */
async function qboBatch(
  accessToken: string,
  realmId: string,
  batchItems: Array<{
    bId: string;
    operation: 'create' | 'update' | 'delete';
    [entityType: string]: unknown;
  }>
): Promise<Array<{ bId: string; success: boolean; entity?: unknown; error?: string }>> {
  const url = `${QBO_BASE_URL}/v3/company/${realmId}/batch?minorversion=73`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ BatchItemRequest: batchItems }),
  });

  if (!response.ok) throw await providerHttpError('QuickBooks', 'batch', response); // audit R9

  const result = await response.json();
  const batchResponses = result.BatchItemResponse ?? [];

  return batchResponses.map((item: any) => {
    if (item.Fault) {
      return {
        bId: item.bId,
        success: false,
        error: item.Fault.Error?.map((e: any) => e.Message).join('; ') ?? 'Unknown error',
      };
    }
    return {
      bId: item.bId,
      success: true,
      entity: item.TimeActivity ?? item,
    };
  });
}

// ---------------------------------------------------------------------------
// QBO Entity Fetchers (for mapping UI)
// ---------------------------------------------------------------------------

export interface QBOEmployee {
  Id: string;
  DisplayName: string;
  PrimaryEmailAddr?: { Address: string };
  Active: boolean;
}

export interface QBOCustomer {
  Id: string;
  DisplayName: string;
  Active: boolean;
}

export interface QBOServiceItem {
  Id: string;
  Name: string;
  Type: string;
  Active: boolean;
}

export interface QBOVendor {
  Id: string;
  DisplayName: string;
  PrimaryEmailAddr?: { Address: string };
  Active: boolean;
}

/**
 * Fetch all active employees from QBO.
 */
export async function fetchQBOEmployees(
  accessToken: string,
  realmId: string
): Promise<Array<{ id: string; name: string; email?: string }>> {
  const employees = await qboQuery<QBOEmployee>(
    accessToken,
    realmId,
    "SELECT * FROM Employee WHERE Active = true MAXRESULTS 1000"
  );

  return employees.map((e) => ({
    id: e.Id,
    name: e.DisplayName,
    email: e.PrimaryEmailAddr?.Address,
  }));
}

/**
 * Fetch all active customers from QBO.
 */
export async function fetchQBOCustomers(
  accessToken: string,
  realmId: string
): Promise<Array<{ id: string; name: string }>> {
  const customers = await qboQuery<QBOCustomer>(
    accessToken,
    realmId,
    "SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000"
  );

  return customers.map((c) => ({
    id: c.Id,
    name: c.DisplayName,
  }));
}

/**
 * Fetch all active service items from QBO.
 */
export async function fetchQBOServiceItems(
  accessToken: string,
  realmId: string
): Promise<Array<{ id: string; name: string }>> {
  const items = await qboQuery<QBOServiceItem>(
    accessToken,
    realmId,
    "SELECT * FROM Item WHERE Type = 'Service' AND Active = true MAXRESULTS 1000"
  );

  return items.map((i) => ({
    id: i.Id,
    name: i.Name,
  }));
}

/**
 * Fetch all active vendors from QBO.
 */
export async function fetchQBOVendors(
  accessToken: string,
  realmId: string
): Promise<Array<{ id: string; name: string; email?: string }>> {
  const vendors = await qboQuery<QBOVendor>(
    accessToken,
    realmId,
    "SELECT * FROM Vendor WHERE Active = true MAXRESULTS 1000"
  );

  return vendors.map((v) => ({
    id: v.Id,
    name: v.DisplayName,
    email: v.PrimaryEmailAddr?.Address,
  }));
}

/**
 * Get company info (to display company name after connecting).
 */
export async function fetchQBOCompanyInfo(
  accessToken: string,
  realmId: string
): Promise<{ companyName: string }> {
  const url = `${QBO_BASE_URL}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=73`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    return { companyName: 'Unknown Company' };
  }

  const data = await response.json();
  return { companyName: data.CompanyInfo?.CompanyName ?? 'Unknown Company' };
}

// ---------------------------------------------------------------------------
// TimeActivity Push
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// QBO Class (dimension for charge code → cost class mapping)
// ---------------------------------------------------------------------------

export interface QBOClass {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  Active?: boolean;
}

export async function fetchQBOClasses(accessToken: string, realmId: string): Promise<QBOClass[]> {
  return qboQuery<QBOClass>(accessToken, realmId, 'SELECT * FROM Class WHERE Active = true MAXRESULTS 1000');
}

export interface TimeActivityInput {
  entryId: string;          // CadenzPoint entry ID for logging
  date: string;             // YYYY-MM-DD
  nameOf: 'Employee' | 'Vendor';  // QBO NameOf field
  employeeRef?: string;     // QBO employee ID (when nameOf = 'Employee')
  vendorRef?: string;       // QBO vendor ID (when nameOf = 'Vendor')
  customerRef?: string;     // QBO customer ID (for billable)
  itemRef?: string;         // QBO service item ID (charge code's service item)
  classRef?: string;        // QBO class ID (charge code's cost class)
  hours: number;
  minutes: number;
  isBillable: boolean;
  description: string;
}

/**
 * Push timesheet entries as QBO TimeActivity records.
 * Uses batch API for performance (up to 30 per batch).
 */
export async function pushTimeActivities(
  accessToken: string,
  realmId: string,
  entries: TimeActivityInput[]
): Promise<Array<{ entryId: string; success: boolean; qboId?: string; error?: string }>> {
  const results: Array<{ entryId: string; success: boolean; qboId?: string; error?: string }> = [];

  // Process in batches of 30 (QBO batch limit)
  for (let i = 0; i < entries.length; i += 30) {
    const batch = entries.slice(i, i + 30);

    const batchItems = batch.map((entry, idx) => {
      const timeActivity: Record<string, unknown> = {
        TxnDate: entry.date,
        NameOf: entry.nameOf,
        Hours: entry.hours,
        Minutes: entry.minutes,
        BillableStatus: entry.isBillable ? 'Billable' : 'NotBillable',
        Description: entry.description,
      };

      // Set EmployeeRef or VendorRef based on NameOf
      if (entry.nameOf === 'Vendor' && entry.vendorRef) {
        timeActivity.VendorRef = { value: entry.vendorRef };
      } else if (entry.employeeRef) {
        timeActivity.EmployeeRef = { value: entry.employeeRef };
      }

      if (entry.customerRef) {
        timeActivity.CustomerRef = { value: entry.customerRef };
      }
      if (entry.itemRef) {
        timeActivity.ItemRef = { value: entry.itemRef };
      }
      if (entry.classRef) {
        timeActivity.ClassRef = { value: entry.classRef };
      }

      return {
        bId: `${i + idx}`,
        operation: 'create' as const,
        TimeActivity: timeActivity,
      };
    });

    const batchResults = await qboBatch(accessToken, realmId, batchItems);

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const result = batchResults[j];

      if (result?.success) {
        results.push({
          entryId: entry.entryId,
          success: true,
          qboId: (result.entity as any)?.Id,
        });
      } else {
        results.push({
          entryId: entry.entryId,
          success: false,
          error: result?.error ?? 'Unknown batch error',
        });
      }
    }
  }

  return results;
}
