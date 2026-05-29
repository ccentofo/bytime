import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, uniqueIndex, integer, index } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum('user_role', ['admin', 'supervisor', 'employee']);
export const statusEnum = pgEnum('record_status', ['active', 'inactive', 'closed']);
export const periodStatusEnum = pgEnum('period_status', ['draft', 'submitted', 'approved', 'rejected']);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('employee'),
  isActive: boolean('is_active').notNull().default(true),
  passwordHash: varchar('password_hash', { length: 255 }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  flsaExempt: boolean('flsa_exempt').notNull().default(false), // FLSA exempt = salaried, must record all hours including uncompensated OT
  sessionVersion: integer('session_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// API Keys (for external system integration)
// ---------------------------------------------------------------------------

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),               // "QuickBooks Integration", "Deltek Sync"
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(), // SHA-256 hash of the API key
  keyPrefix: varchar('key_prefix', { length: 8 }).notNull(),       // First 8 chars for identification (e.g., "byt_a1b2")
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  permissions: varchar('permissions', { length: 50 }).notNull().default('read'), // 'read' or 'read-write'
  isActive: boolean('is_active').notNull().default(true),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),        // nullable — null means no expiry
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Indirect Charge Code Categories
// ---------------------------------------------------------------------------

export const indirectCategoryEnum = pgEnum('indirect_category', [
  'overhead',      // Overhead / fringe
  'ga',            // General & Administrative
  'irad',          // Independent Research & Development
  'bp',            // Bid & Proposal
  'leave',         // Leave (annual, sick, holiday, LWOP)
  'unallowable',   // Unallowable costs (FAR 31.205)
]);

// ---------------------------------------------------------------------------
// Indirect Charge Codes (overhead, G&A, leave, etc.)
// ---------------------------------------------------------------------------

export const indirectChargeCodes = pgTable('indirect_charge_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  category: indirectCategoryEnum('category').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  availableToAll: boolean('available_to_all').notNull().default(true), // if true, all employees can charge to this
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Login Attempts (brute-force protection — tracks failed login attempts)
// ---------------------------------------------------------------------------

export const loginAttempts = pgTable('login_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }), // IPv4 or IPv6
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  successful: boolean('successful').notNull().default(false),
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const contracts = pgTable('contracts', {
  id: uuid('id').defaultRandom().primaryKey(),
  contractNumber: varchar('contract_number', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  contractType: varchar('contract_type', { length: 20 }).notNull().default('prime'), // 'prime' or 'sub'
  status: statusEnum('status').notNull().default('active'),
  startDate: timestamp('start_date', { withTimezone: true }),
  endDate: timestamp('end_date', { withTimezone: true }),
  fundedValue: varchar('funded_value', { length: 20 }),     // currently obligated/funded amount
  ceilingValue: varchar('ceiling_value', { length: 20 }),   // maximum contract ceiling
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// CLINs (Contract Line Item Numbers)
// ---------------------------------------------------------------------------

export const clins = pgTable('clins', {
  id: uuid('id').defaultRandom().primaryKey(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  clinNumber: varchar('clin_number', { length: 50 }).notNull(),
  description: text('description'),
  fundedAmount: varchar('funded_amount', { length: 20 }), // funded amount for this CLIN
  status: statusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// SLINs (Sub-Line Item Numbers) — optional subdivision of CLINs
// ---------------------------------------------------------------------------

export const slins = pgTable('slins', {
  id: uuid('id').defaultRandom().primaryKey(),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  slinNumber: varchar('slin_number', { length: 50 }).notNull(),
  description: text('description'),
  fundedAmount: varchar('funded_amount', { length: 20 }), // funded amount for this SLIN
  status: statusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('clin_slin_unique_idx').on(table.clinId, table.slinNumber),
]);

// ---------------------------------------------------------------------------
// User Assignments (DCAA RBAC enforcement)
// ---------------------------------------------------------------------------

export const userAssignments = pgTable('user_assignments', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  slinId: uuid('slin_id').references(() => slins.id, { onDelete: 'cascade' }), // nullable — SLIN-level assignment
  isActive: boolean('is_active').notNull().default(true),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedBy: uuid('assigned_by').references(() => users.id),
}, (table) => [
  uniqueIndex('user_clin_unique_idx').on(table.userId, table.clinId),
]);

// ---------------------------------------------------------------------------
// Labor Categories (billing rates per CLIN)
// ---------------------------------------------------------------------------

export const laborCategories = pgTable('labor_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  slinId: uuid('slin_id').references(() => slins.id, { onDelete: 'cascade' }), // nullable — SLIN-level LCAT
  lcatCode: varchar('lcat_code', { length: 50 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  hourlyRate: varchar('hourly_rate', { length: 20 }).notNull().default('0.00'),
  ceilingRate: varchar('ceiling_rate', { length: 20 }),
  status: statusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('clin_lcat_unique_idx').on(table.clinId, table.lcatCode),
]);

// ---------------------------------------------------------------------------
// User Labor Categories (maps employees to their authorized LCAT + rate)
// ---------------------------------------------------------------------------

export const userLaborCategories = pgTable('user_labor_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  laborCategoryId: uuid('labor_category_id').notNull().references(() => laborCategories.id, { onDelete: 'cascade' }),
  effectiveDate: timestamp('effective_date', { withTimezone: true }).notNull(),
  endDate: timestamp('end_date', { withTimezone: true }),
  assignedBy: uuid('assigned_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_lcat_effective_unique_idx').on(table.userId, table.laborCategoryId, table.effectiveDate),
]);

// ---------------------------------------------------------------------------
// Timesheet Entries (DCAA append-only — NEVER update or delete rows)
// ---------------------------------------------------------------------------

export const timesheetEntries = pgTable('timesheet_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  clinId: uuid('clin_id').references(() => clins.id), // nullable — null for indirect charge entries
  slinId: uuid('slin_id').references(() => slins.id), // nullable — SLIN-level entry
  indirectCodeId: uuid('indirect_code_id').references(() => indirectChargeCodes.id), // nullable — set for indirect entries
  entryDate: timestamp('entry_date', { withTimezone: true }).notNull(),
  hours: varchar('hours', { length: 10 }).notNull().default('0'), // stored as string to preserve exact decimal input
  revisionNumber: integer('revision_number').notNull().default(1),
  changeReasonCode: varchar('change_reason_code', { length: 50 }),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id),
}, (table) => [
  // Performance index: speeds up the MAX(revision_number) correlated subquery
  // used in every timesheet read query. Without this, each lookup scans the full table.
  // DO NOT REMOVE — this is critical for page load performance.
  index('idx_entries_user_clin_date_rev').on(table.userId, table.clinId, table.entryDate, table.revisionNumber),
  index('idx_entries_user_indirect_date_rev').on(table.userId, table.indirectCodeId, table.entryDate, table.revisionNumber),
]);

// ---------------------------------------------------------------------------
// Timesheet Periods (tracks period lifecycle: draft → submitted → approved/rejected)
// ---------------------------------------------------------------------------

export const timesheetPeriods = pgTable('timesheet_periods', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  status: periodStatusEnum('status').notNull().default('draft'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedComment: text('submitted_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewComment: text('review_comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_period_unique_idx').on(table.userId, table.periodStart),
]);

// ---------------------------------------------------------------------------
// Notification Preferences (per-user email notification settings)
// ---------------------------------------------------------------------------

export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  emailOnSubmit: boolean('email_on_submit').notNull().default(true),       // supervisor: when employee submits
  emailOnApprove: boolean('email_on_approve').notNull().default(true),     // employee: when timesheet approved
  emailOnReject: boolean('email_on_reject').notNull().default(true),       // employee: when timesheet rejected
  emailDailyReminder: boolean('email_daily_reminder').notNull().default(true), // employee: daily entry reminder
  emailDeadlineReminder: boolean('email_deadline_reminder').notNull().default(true), // employee: submission deadline
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Password Reset Tokens (self-service forgot password)
// ---------------------------------------------------------------------------

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(), // SHA-256 hash of the reset token
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),                // null until token is consumed
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Integration Provider Enum
// ---------------------------------------------------------------------------

export const integrationProviderEnum = pgEnum('integration_provider', [
  'quickbooks_online',
  'gusto',
  'adp',
  'paychex',
  'sage_intacct',
  'csv_export',
]);

export const integrationSyncStatusEnum = pgEnum('integration_sync_status', [
  'pending',
  'running',
  'success',
  'partial',   // some records succeeded, some failed
  'failed',
]);

// ---------------------------------------------------------------------------
// Integration Connections (OAuth tokens + connection state per provider)
// ---------------------------------------------------------------------------

export const integrationConnections = pgTable('integration_connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  provider: integrationProviderEnum('provider').notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),  // "QuickBooks — Acme Corp"
  externalCompanyId: varchar('external_company_id', { length: 255 }), // QBO realmId, Gusto companyId, etc.
  externalCompanyName: varchar('external_company_name', { length: 255 }),
  accessTokenEncrypted: text('access_token_encrypted'),              // AES-256-GCM encrypted
  refreshTokenEncrypted: text('refresh_token_encrypted'),            // AES-256-GCM encrypted
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: text('scopes'),                                            // comma-separated OAuth scopes granted
  isActive: boolean('is_active').notNull().default(true),
  autoSyncOnApproval: boolean('auto_sync_on_approval').notNull().default(false),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncStatus: integrationSyncStatusEnum('last_sync_status'),
  connectedBy: uuid('connected_by').notNull().references(() => users.id),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Integration Entity Mappings (ByTime entity ↔ External entity)
// ---------------------------------------------------------------------------

export const integrationEntityMappings = pgTable('integration_entity_mappings', {
  id: uuid('id').defaultRandom().primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => integrationConnections.id, { onDelete: 'cascade' }),
  entityType: varchar('entity_type', { length: 50 }).notNull(),      // 'employee', 'contract', 'clin', 'indirect_code'
  bytimeEntityId: uuid('bytime_entity_id').notNull(),                 // ID of the ByTime record
  bytimeEntityName: varchar('bytime_entity_name', { length: 255 }),   // Display name for UI
  externalEntityId: varchar('external_entity_id', { length: 255 }).notNull(),  // ID in the external system
  externalEntityName: varchar('external_entity_name', { length: 255 }),         // Display name from external system
  metadata: text('metadata'),                                         // JSON — provider-specific extra data
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('mapping_unique_idx').on(table.connectionId, table.entityType, table.bytimeEntityId),
]);

// ---------------------------------------------------------------------------
// Integration Sync Logs (audit trail of every sync operation)
// ---------------------------------------------------------------------------

export const integrationSyncLogs = pgTable('integration_sync_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => integrationConnections.id, { onDelete: 'cascade' }),
  syncType: varchar('sync_type', { length: 50 }).notNull(),          // 'timesheet_push', 'invoice_push', 'employee_sync'
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  triggeredBy: uuid('triggered_by').references(() => users.id),      // null for auto-sync
  triggerType: varchar('trigger_type', { length: 20 }).notNull().default('manual'), // 'manual', 'auto', 'retry'
  recordsPushed: integer('records_pushed').notNull().default(0),
  recordsFailed: integer('records_failed').notNull().default(0),
  recordsSkipped: integer('records_skipped').notNull().default(0),
  status: integrationSyncStatusEnum('status').notNull().default('pending'),
  errorSummary: text('error_summary'),                                // High-level error message if failed
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Integration Sync Records (per-record detail within a sync)
// ---------------------------------------------------------------------------

export const integrationSyncRecords = pgTable('integration_sync_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  syncLogId: uuid('sync_log_id').notNull().references(() => integrationSyncLogs.id, { onDelete: 'cascade' }),
  bytimeEntityType: varchar('bytime_entity_type', { length: 50 }).notNull(), // 'timesheet_entry', 'invoice_line'
  bytimeEntityId: varchar('bytime_entity_id', { length: 255 }).notNull(), // ID of the ByTime record pushed (composite key for timesheet entries)
  externalEntityId: varchar('external_entity_id', { length: 255 }),   // ID assigned by external system
  status: varchar('status', { length: 20 }).notNull(),                // 'success', 'failed', 'skipped'
  errorMessage: text('error_message'),
  requestPayload: text('request_payload'),                            // JSON — what was sent (for debugging)
  responsePayload: text('response_payload'),                          // JSON — what came back
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
