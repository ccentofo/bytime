import type {
  IntegrationConnector,
  ConnectorMetadata,
  OAuthConfig,
  PayrollSyncInput,
  SyncContext,
  SyncResult,
} from '../types';
import {
  exchangeGustoCode,
  refreshGustoToken,
  fetchGustoEmployees,
  fetchGustoCurrentUser,
  gustoGetRaw,
  fetchGustoCompanyInfo,
} from './gusto-api';
import { getDbForWrite } from '@/db';
import { integrationSyncRecords } from '@/db/schema';
import { safeErrorMessage } from '@/server/internal/import-errors';
import { FLSA_LABEL } from './payroll-export';

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

  /**
   * certified-outputs C7: records each employee's FLSA weekly-overtime totals (from payroll-data, routed by
   * executeSyncOperation) as a sync record for the payroll admin. Still no Gusto API call — a real integration is out
   * of scope (none existed before).
   */
  async pushPayroll(context: SyncContext, payroll: PayrollSyncInput): Promise<SyncResult> {
    const db = await getDbForWrite();
    const employeeMappings = context.mappings.get('employee') ?? new Map();

    const result: SyncResult = { pushed: 0, failed: 0, skipped: 0, errors: [] };

    for (const emp of payroll.employees) {
      const gustoEmployeeId = employeeMappings.get(emp.userId);
      if (!gustoEmployeeId) {
        result.skipped++;
        result.errors.push({
          bytimeEntityId: emp.userId,
          error: `Employee "${emp.employeeName}" is not mapped to a Gusto employee. Skipping.`,
        });
        continue;
      }

      try {
        result.pushed++;

        await db.insert(integrationSyncRecords).values({
          syncLogId: context.syncLogId,
          bytimeEntityType: 'employee_hours',
          bytimeEntityId: emp.userId,
          externalEntityId: gustoEmployeeId,
          status: 'success',
          errorMessage: null,
          requestPayload: JSON.stringify({
            method: FLSA_LABEL,
            employeeName: emp.employeeName,
            regularHours: emp.regularHours,
            overtimeHours: emp.overtimeHours,
            ptoHours: emp.ptoHours,
            sickHours: emp.sickHours,
            holidayHours: emp.holidayHours,
            uncompensatedOvertimeHours: emp.uncompensatedOvertimeHours,
            flagged: emp.flagged,
            periodStart: payroll.periodStart,
            periodEnd: payroll.periodEnd,
          }),
          responsePayload: null,
        });
      } catch (error) {
        result.failed++;
        result.errors.push({
          bytimeEntityId: emp.userId,
          // Audit R7: shown in the admin sync log and the export — never a raw DB error (SQL + params).
          error: safeErrorMessage(error, { fallback: 'Could not sync this employee.', logLabel: 'Gusto sync record failed:' }),
        });
      }
    }

    return result;
  },
};
