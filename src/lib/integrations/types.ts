/**
 * Shared types for the Integration Hub connector framework.
 * Each connector (QBO, Gusto, etc.) implements the IntegrationConnector interface.
 */

export interface ConnectorMetadata {
  id: string;                        // 'quickbooks_online', 'gusto', etc.
  name: string;                      // 'QuickBooks Online'
  description: string;               // 'Push approved timesheets to QBO for payroll and invoicing'
  icon: string;                      // Tabler icon name (e.g., 'IconBrandQuickbooks')
  color: string;                     // Mantine color for the card
  category: 'accounting' | 'payroll' | 'export';
  authType: 'oauth2' | 'api_key' | 'file_export';
  requiredMappings: EntityMappingType[];  // Which entity types need mapping
  capabilities: ConnectorCapability[];
}

export type EntityMappingType = 'employee' | 'contract' | 'clin' | 'indirect_code';

export type ConnectorCapability =
  | 'push_timesheets'       // Push approved hours
  | 'push_invoices'         // Push billing/invoice data
  | 'push_journal_entries'  // Push GL journal entries
  | 'pull_employees'        // Pull employee list for mapping
  | 'pull_customers'        // Pull customer list for mapping
  | 'pull_service_items'    // Pull service items for mapping
  | 'file_export';          // Download a file (CSV, IIF, etc.)

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  callbackPath: string;      // e.g., '/api/integrations/callback/quickbooks_online'
}

export interface SyncContext {
  connectionId: string;
  syncLogId: string;
  accessToken: string;
  externalCompanyId: string;
  mappings: Map<string, Map<string, string>>;  // entityType → (bytimeId → externalId)
}

export interface SyncResult {
  pushed: number;
  failed: number;
  skipped: number;
  errors: Array<{
    bytimeEntityId: string;
    error: string;
  }>;
}

/**
 * Interface that each connector must implement.
 * Not all methods are required — only those matching the connector's capabilities.
 */
export interface IntegrationConnector {
  metadata: ConnectorMetadata;

  // OAuth flow (for oauth2 auth type)
  getOAuthConfig?(): OAuthConfig;
  exchangeCodeForTokens?(code: string, realmId?: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    realmId?: string;
    companyName?: string;
  }>;
  refreshAccessToken?(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }>;

  // Entity fetching (for mapping UI)
  fetchExternalEmployees?(accessToken: string, companyId: string): Promise<Array<{
    id: string;
    name: string;
    email?: string;
  }>>;
  fetchExternalCustomers?(accessToken: string, companyId: string): Promise<Array<{
    id: string;
    name: string;
  }>>;
  fetchExternalServiceItems?(accessToken: string, companyId: string): Promise<Array<{
    id: string;
    name: string;
  }>>;

  // Sync operations
  pushTimesheetEntries?(context: SyncContext, entries: TimesheetSyncEntry[]): Promise<SyncResult>;
  pushInvoice?(context: SyncContext, invoiceData: unknown): Promise<SyncResult>;

  // File export (for file_export auth type)
  generateExportFile?(entries: TimesheetSyncEntry[], format: string): Promise<{
    content: string | Buffer;
    filename: string;
    mimeType: string;
  }>;
}

/**
 * Timesheet data shaped for sync — one record per employee per day per charge code.
 */
export interface TimesheetSyncEntry {
  userId: string;
  employeeName: string;
  employeeEmail: string;
  entryDate: Date;
  hours: number;
  chargeCodeId: string;          // CLIN ID or indirect code ID
  chargeCodeLabel: string;       // "NAVAIR / 0001" or "OH-001"
  contractId?: string;           // Contract UUID (for contract mapping lookup)
  contractNumber?: string;
  clinNumber?: string;
  indirectCode?: string;
  isBillable: boolean;           // true for direct, false for indirect
  periodStart: Date;
  approvedAt: Date | null;
}
