import { db } from '@/db';
import { integrationConnections } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '@/lib/encryption';

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
export function getQBOAuthUrl(state?: string): string {
  const { clientId } = getClientCredentials();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const redirectUri = `${appUrl}/api/integrations/callback/quickbooks_online`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state: state ?? 'bytime_qbo_connect',
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

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshQBOToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { clientId, clientSecret } = getClientCredentials();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

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
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QBO token refresh failed: ${response.status} ${errorBody}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

/**
 * Ensure the access token for a connection is valid.
 * If it's expired or about to expire (within 5 minutes), refresh it.
 * Returns the valid access token.
 */
export async function ensureValidToken(connectionId: string): Promise<string> {
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

  // Token is still valid
  if (expiresAt > fiveMinutesFromNow) {
    return decrypt(connection.accessTokenEncrypted);
  }

  // Token expired or about to expire — refresh
  const currentRefreshToken = decrypt(connection.refreshTokenEncrypted);
  const newTokens = await refreshQBOToken(currentRefreshToken);

  // Store the new tokens
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

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QBO query failed: ${response.status} ${errorBody}`);
  }

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

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QBO create ${entityType} failed: ${response.status} ${errorBody}`);
  }

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

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QBO batch failed: ${response.status} ${errorBody}`);
  }

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

export interface TimeActivityInput {
  entryId: string;          // ByTime entry ID for logging
  date: string;             // YYYY-MM-DD
  nameOf: 'Employee' | 'Vendor';  // QBO NameOf field
  employeeRef?: string;     // QBO employee ID (when nameOf = 'Employee')
  vendorRef?: string;       // QBO vendor ID (when nameOf = 'Vendor')
  customerRef?: string;     // QBO customer ID (for billable)
  itemRef?: string;         // QBO service item ID
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
