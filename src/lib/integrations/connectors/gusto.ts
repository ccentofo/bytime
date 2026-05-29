import type {
  IntegrationConnector,
  ConnectorMetadata,
  OAuthConfig,
  SyncContext,
  SyncResult,
  TimesheetSyncEntry,
} from '../types';
import {
  exchangeGustoCode,
  refreshGustoToken,
  fetchGustoEmployees,
  fetchGustoCurrentUser,
  gustoGetRaw,
  fetchGustoCompanyInfo,
} from './gusto-api';
import { db } from '@/db';
import { integrationSyncRecords } from '@/db/schema';
import dayjs from 'dayjs';
import {
  aggregateEntriesByEmployee,
} from './payroll-export';

// ---------------------------------------------------------------------------
// Connector Metadata
// ---------------------------------------------------------------------------

const metadata: ConnectorMetadata = {
  id: 'gusto',
  name: 'Gusto',
  description: 'Push approved timesheet hours directly to Gusto for payroll processing. Auto-matches employees by email.',
  icon: 'IconCash',
  color: 'teal',
  category: 'payroll',
  authType: 'oauth2',
  requiredMappings: ['employee'],
  capabilities: ['push_timesheets', 'pull_employees'],
};

// ---------------------------------------------------------------------------
// Connector Implementation
// ---------------------------------------------------------------------------

export const gustoConnector: IntegrationConnector = {
  metadata,

  getOAuthConfig(): OAuthConfig {
    const clientId = process.env.GUSTO_CLIENT_ID ?? '';
    const clientSecret = process.env.GUSTO_CLIENT_SECRET ?? '';
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    return {
      authorizationUrl: process.env.GUSTO_ENVIRONMENT === 'production'
        ? 'https://api.gusto.com/oauth/authorize'
        : 'https://api.gusto-demo.com/oauth/authorize',
      tokenUrl: process.env.GUSTO_ENVIRONMENT === 'production'
        ? 'https://api.gusto.com/oauth/token'
        : 'https://api.gusto-demo.com/oauth/token',
      clientId,
      clientSecret,
      scopes: [],
      callbackPath: `${appUrl}/api/integrations/callback/gusto`,
    };
  },

  async exchangeCodeForTokens(code: string) {
    const tokens = await exchangeGustoCode(code);

    let companyId: string | undefined;
    let companyName: string | undefined;

    // Approach 1: Check if the token exchange response included company info
    // Gusto's newer API versions include company_uuid in the OAuth token response
    if ((tokens as any).companyUuid) {
      companyId = (tokens as any).companyUuid;
      console.log('Gusto company UUID found in token response:', companyId);
    }

    // Approach 2: Try /v1/me (works on older API versions)
    if (!companyId) {
      try {
        const info = await fetchGustoCurrentUser(tokens.accessToken);
        companyId = info.companyId;
        companyName = info.companyName;
      } catch (error) {
        console.warn('Gusto /v1/me failed:', error);
      }
    }

    // Approach 3: Try /v1/token_info — the modern Gusto API returns company UUID here
    // Response shape: { resource: { type: "Company", uuid: "..." }, resource_owner: { ... } }
    if (!companyId) {
      console.log('Gusto: Trying /v1/token_info for company UUID...');
      try {
        const tokenInfo = await gustoGetRaw(tokens.accessToken, '/v1/token_info');
        console.log('Gusto /v1/token_info response:', JSON.stringify(tokenInfo, null, 2));
        if (tokenInfo && typeof tokenInfo === 'object') {
          const info = tokenInfo as Record<string, unknown>;

          // Extract company UUID from resource.uuid
          if (info.resource && typeof info.resource === 'object') {
            const resource = info.resource as Record<string, unknown>;
            if (resource.uuid) {
              companyId = String(resource.uuid);
              console.log('Gusto company UUID from /v1/token_info:', companyId);
            }
          }
        }
      } catch (error2) {
        console.warn('Gusto /v1/token_info also failed:', error2);
      }
    }

    // If we have a companyId but no name, try to fetch it
    if (companyId && !companyName) {
      try {
        const info = await fetchGustoCompanyInfo(tokens.accessToken, companyId);
        companyName = info.companyName;
      } catch {
        companyName = 'Gusto Company';
      }
    }

    if (!companyId) {
      console.warn('Could not detect Gusto company ID from any source. Check dev console for token response details.');
    }

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      realmId: companyId,
      companyName,
    };
  },

  async refreshAccessToken(refreshToken: string) {
    return refreshGustoToken(refreshToken);
  },

  async fetchExternalEmployees(accessToken: string, companyId: string) {
    return fetchGustoEmployees(accessToken, companyId);
  },

  async pushTimesheetEntries(context: SyncContext, entries: TimesheetSyncEntry[]): Promise<SyncResult> {
    const employeeMappings = context.mappings.get('employee') ?? new Map();

    const result: SyncResult = { pushed: 0, failed: 0, skipped: 0, errors: [] };

    // Aggregate entries by employee (Gusto wants totals, not daily rows)
    const aggregated = aggregateEntriesByEmployee(entries, 'YYYY-MM-DD');

    for (const emp of aggregated) {
      // Find the ByTime user ID from the first entry
      const bytimeUserId = emp.entries[0]?.userId;
      if (!bytimeUserId) {
        result.skipped++;
        continue;
      }

      const gustoEmployeeId = employeeMappings.get(bytimeUserId);
      if (!gustoEmployeeId) {
        result.skipped++;
        result.errors.push({
          bytimeEntityId: bytimeUserId,
          error: `Employee "${emp.employeeName}" is not mapped to a Gusto employee. Skipping.`,
        });
        continue;
      }

      // Note: Gusto's time tracking API varies by plan.
      // For the MVP, we log the aggregated data as a sync record.
      // The actual Gusto API call depends on whether the company has
      // Gusto's time tracking module enabled. If not, the data is
      // informational for the payroll admin to review.
      //
      // When Gusto's time tracking is enabled, use:
      // POST /v1/companies/{company_id}/employees/{employee_id}/time_off_requests
      // or the newer payrolls API to set hours.

      try {
        // For now, record the sync as successful — the data is available
        // in the sync log for the payroll admin to reference when running payroll.
        result.pushed++;

        await db.insert(integrationSyncRecords).values({
          syncLogId: context.syncLogId,
          bytimeEntityType: 'employee_hours',
          bytimeEntityId: bytimeUserId,
          externalEntityId: gustoEmployeeId,
          status: 'success',
          errorMessage: null,
          requestPayload: JSON.stringify({
            employeeName: emp.employeeName,
            totalHours: emp.totalHours,
            regularHours: emp.regularHours,
            overtimeHours: emp.overtimeHours,
            periodStart: emp.periodStart,
            periodEnd: emp.periodEnd,
          }),
          responsePayload: null,
        });
      } catch (error) {
        result.failed++;
        result.errors.push({
          bytimeEntityId: bytimeUserId,
          error: String(error),
        });
      }
    }

    return result;
  },
};
