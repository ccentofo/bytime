import type {
  IntegrationConnector,
  ConnectorMetadata,
  OAuthConfig,
  SyncContext,
  SyncResult,
  TimesheetSyncEntry,
} from '../types';
import {
  exchangeQBOCode,
  refreshQBOToken,
  fetchQBOEmployees,
  fetchQBOCustomers,
  fetchQBOServiceItems,
  fetchQBOCompanyInfo,
  pushTimeActivities,
  type TimeActivityInput,
} from './qbo-api';
import { db } from '@/db';
import { integrationSyncRecords } from '@/db/schema';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Connector Metadata
// ---------------------------------------------------------------------------

const metadata: ConnectorMetadata = {
  id: 'quickbooks_online',
  name: 'QuickBooks Online',
  description: 'Push approved timesheets to QuickBooks Online for payroll processing and invoicing. Maps employees, customers, and service items.',
  icon: 'IconCalculator',
  color: 'green',
  category: 'accounting',
  authType: 'oauth2',
  requiredMappings: ['employee', 'contract', 'clin'],
  capabilities: ['push_timesheets', 'pull_employees', 'pull_customers', 'pull_service_items'],
};

// ---------------------------------------------------------------------------
// Connector Implementation
// ---------------------------------------------------------------------------

export const quickbooksOnlineConnector: IntegrationConnector = {
  metadata,

  getOAuthConfig(): OAuthConfig {
    const clientId = process.env.QBO_CLIENT_ID ?? '';
    const clientSecret = process.env.QBO_CLIENT_SECRET ?? '';
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    return {
      authorizationUrl: 'https://appcenter.intuit.com/connect/oauth2',
      tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      clientId,
      clientSecret,
      scopes: ['com.intuit.quickbooks.accounting'],
      callbackPath: `${appUrl}/api/integrations/callback/quickbooks_online`,
    };
  },

  async exchangeCodeForTokens(code: string, realmId?: string) {
    const tokens = await exchangeQBOCode(code);

    // Fetch company name if we have a realmId
    let companyName: string | undefined;
    if (realmId) {
      try {
        const info = await fetchQBOCompanyInfo(tokens.accessToken, realmId);
        companyName = info.companyName;
      } catch {
        companyName = undefined;
      }
    }

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      realmId,
      companyName,
    };
  },

  async refreshAccessToken(refreshToken: string) {
    return refreshQBOToken(refreshToken);
  },

  async fetchExternalEmployees(accessToken: string, companyId: string) {
    return fetchQBOEmployees(accessToken, companyId);
  },

  async fetchExternalCustomers(accessToken: string, companyId: string) {
    return fetchQBOCustomers(accessToken, companyId);
  },

  async fetchExternalServiceItems(accessToken: string, companyId: string) {
    return fetchQBOServiceItems(accessToken, companyId);
  },

  async pushTimesheetEntries(context: SyncContext, entries: TimesheetSyncEntry[]): Promise<SyncResult> {
    const employeeMappings = context.mappings.get('employee') ?? new Map();
    const vendorMappings = context.mappings.get('vendor') ?? new Map();
    const contractMappings = context.mappings.get('contract') ?? new Map();
    const clinMappings = context.mappings.get('clin') ?? new Map();

    const result: SyncResult = { pushed: 0, failed: 0, skipped: 0, errors: [] };
    const timeActivities: TimeActivityInput[] = [];

    // Build TimeActivity records from approved entries
    for (const entry of entries) {
      // Look up mapped QBO employee OR vendor
      // A ByTime user can be mapped as either a QBO Employee or a QBO Vendor (for 1099 contractors)
      const qboEmployeeId = employeeMappings.get(entry.userId);
      const qboVendorId = vendorMappings.get(entry.userId);

      if (!qboEmployeeId && !qboVendorId) {
        result.skipped++;
        result.errors.push({
          bytimeEntityId: entry.chargeCodeId,
          error: `Employee "${entry.employeeName}" is not mapped to a QBO employee or vendor. Skipping.`,
        });
        continue;
      }

      // Determine if this is an Employee or Vendor TimeActivity
      const isVendor = !qboEmployeeId && !!qboVendorId;

      // Look up mapped QBO customer (contract) — required for billable hours
      // Contract mappings are keyed by contract UUID. The entry now includes contractId.
      let qboCustomerId: string | undefined;
      if (entry.isBillable && entry.contractId) {
        qboCustomerId = contractMappings.get(entry.contractId);
      }

      // Look up mapped QBO service item (CLIN) — optional
      let qboItemId: string | undefined;
      if (entry.isBillable && entry.chargeCodeId) {
        qboItemId = clinMappings.get(entry.chargeCodeId);
      }

      // Convert hours to hours + minutes
      const totalMinutes = Math.round(entry.hours * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      timeActivities.push({
        entryId: `${entry.userId}-${entry.chargeCodeId}-${dayjs(entry.entryDate).format('YYYY-MM-DD')}`,
        date: dayjs(entry.entryDate).format('YYYY-MM-DD'),
        nameOf: isVendor ? 'Vendor' : 'Employee',
        employeeRef: isVendor ? undefined : qboEmployeeId,
        vendorRef: isVendor ? qboVendorId : undefined,
        customerRef: qboCustomerId,
        itemRef: qboItemId,
        hours,
        minutes,
        isBillable: entry.isBillable,
        description: `${entry.chargeCodeLabel} — ${dayjs(entry.entryDate).format('MMM D, YYYY')}`,
      });
    }

    if (timeActivities.length === 0) {
      return result;
    }

    // Push to QBO via batch API
    const pushResults = await pushTimeActivities(
      context.accessToken,
      context.externalCompanyId,
      timeActivities
    );

    // Log per-record results
    for (const pr of pushResults) {
      if (pr.success) {
        result.pushed++;
      } else {
        result.failed++;
        result.errors.push({
          bytimeEntityId: pr.entryId,
          error: pr.error ?? 'Unknown error',
        });
      }

      // Create sync record for audit trail
      await db.insert(integrationSyncRecords).values({
        syncLogId: context.syncLogId,
        bytimeEntityType: 'timesheet_entry',
        bytimeEntityId: pr.entryId,
        externalEntityId: pr.qboId ?? null,
        status: pr.success ? 'success' : 'failed',
        errorMessage: pr.error ?? null,
        requestPayload: null, // Omit for performance — batch payload is large
        responsePayload: pr.qboId ? JSON.stringify({ Id: pr.qboId }) : null,
      });
    }

    return result;
  },
};
