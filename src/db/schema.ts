import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, uniqueIndex, integer, index, jsonb, date, smallint, check, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Date columns below use `date(..., { mode: 'string' })` — Drizzle maps these to a plain JS
// string ('YYYY-MM-DD'), never a JS Date. Callers brand that string as `CalendarDate` (see
// src/lib/calendar-date.ts) via `parseCalendarDate` at the point it enters application logic;
// this version of Drizzle (0.45) has no column-level `$type<>()` override to do that in the
// schema itself.

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
  totpSecret: text('totp_secret'),                    // Encrypted TOTP secret (null = 2FA disabled)
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  totpRecoveryCodes: text('totp_recovery_codes'),     // Encrypted JSON array of hashed recovery codes
  // R2-12: last accepted TOTP time-step (30s window), so a code can never be replayed even
  // within its own validity window. Nullable — no value yet means no code has been accepted.
  totpLastUsedStep: integer('totp_last_used_step'),
  // feature-plan-certified-outputs.md C2 (CO-D5/CO-D12): the explicitly designated approver of a supervisor- or
  // admin-role user. Honoured only while this user's role is supervisor/admin and the designee is an active
  // admin/supervisor (src/server/internal/approval-rules.ts); otherwise ineffective but kept.
  approverId: uuid('approver_id').references((): AnyPgColumn => users.id),
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
  // feature-plan-certified-outputs.md C7 (CO-D11/CO-D16): how a LEAVE code is paid in the payroll export. Required by
  // the app when category = 'leave'; null on other categories (and on pre-existing custom leave codes until set).
  leavePayType: varchar('leave_pay_type', { length: 10 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('indirect_charge_codes_leave_pay_type_check', sql`${table.leavePayType} IS NULL OR ${table.leavePayType} IN ('pto', 'sick', 'holiday', 'unpaid')`),
]);

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
  startDate: date('start_date', { mode: 'string' }),
  endDate: date('end_date', { mode: 'string' }),
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

// Dated rate changes (feature-plan-dated-rates.md). labor_categories.hourly_rate / ceiling_rate are the STARTING
// rate (days before the first change). Rate on day D = latest change with effective_date <= D, else the starting
// rate. No end dates by design: periods can't overlap or leave gaps.
export const laborCategoryRates = pgTable('labor_category_rates', {
  id: uuid('id').defaultRandom().primaryKey(),
  laborCategoryId: uuid('labor_category_id').notNull().references(() => laborCategories.id, { onDelete: 'cascade' }),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  hourlyRate: varchar('hourly_rate', { length: 20 }).notNull(),  // validateRate format, same type as the starting rate
  ceilingRate: varchar('ceiling_rate', { length: 20 }),           // null = no ceiling in this period
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('lcat_rate_effective_unique_idx').on(table.laborCategoryId, table.effectiveDate),
]);

// ---------------------------------------------------------------------------
// User Labor Categories (maps employees to their authorized LCAT + rate)
// ---------------------------------------------------------------------------

export const userLaborCategories = pgTable('user_labor_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  laborCategoryId: uuid('labor_category_id').notNull().references(() => laborCategories.id, { onDelete: 'cascade' }),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }), // INCLUSIVE last day (readers use end_date >= entry_date); null = open-ended
  assignedBy: uuid('assigned_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_lcat_effective_unique_idx').on(table.userId, table.laborCategoryId, table.effectiveDate),
  // feature-plan-certified-outputs.md C3: the cost-basis lookup (employee's assignments effective on a date).
  index('idx_user_lcat_user_effective').on(table.userId, table.effectiveDate),
]);

// ---------------------------------------------------------------------------
// Work Location Enum (onsite vs telework charge to different codes under the same CLIN)
// ---------------------------------------------------------------------------

export const workLocationEnum = pgEnum('work_location', ['onsite', 'telework', 'other']);

// ---------------------------------------------------------------------------
// Cost Classes (QBO "Class" dimension — e.g. "Government Services")
// ---------------------------------------------------------------------------

export const costClasses = pgTable('cost_classes', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Charge Codes (first-class DIRECT charge codes — employees pick these, not raw CLINs)
// ---------------------------------------------------------------------------

export const chargeCodes = pgTable('charge_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 100 }).notNull().unique(),        // e.g. "G0490.ID.IaaS.OY7.SWE3"
  name: varchar('name', { length: 255 }).notNull(),                 // human label
  description: text('description'),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  slinId: uuid('slin_id').references(() => slins.id, { onDelete: 'set null' }),
  laborCategoryId: uuid('labor_category_id').references(() => laborCategories.id, { onDelete: 'set null' }),
  classId: uuid('class_id').references(() => costClasses.id, { onDelete: 'set null' }),
  workLocation: workLocationEnum('work_location'),                   // nullable
  billable: boolean('billable').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_charge_codes_clin').on(table.clinId),
]);

// Dated labor category of a charge code (feature-plan-dated-rates.md D3). charge_codes.labor_category_id is the STARTING
// category (may be null); a dated change always names a category (FK default NO ACTION — never SET NULL). Category of
// code K on day D = latest change with effective_date <= D, else the starting category.
export const chargeCodeLaborCategories = pgTable('charge_code_labor_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  chargeCodeId: uuid('charge_code_id').notNull().references(() => chargeCodes.id, { onDelete: 'cascade' }),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  laborCategoryId: uuid('labor_category_id').notNull().references(() => laborCategories.id),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('cc_lcat_effective_unique_idx').on(table.chargeCodeId, table.effectiveDate),
]);

// ---------------------------------------------------------------------------
// User Charge Codes (employee's direct pick-list — which charge codes they may charge to)
// ---------------------------------------------------------------------------

export const userChargeCodes = pgTable('user_charge_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chargeCodeId: uuid('charge_code_id').notNull().references(() => chargeCodes.id, { onDelete: 'cascade' }),
  isActive: boolean('is_active').notNull().default(true),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedBy: uuid('assigned_by').references(() => users.id),
}, (table) => [
  uniqueIndex('user_charge_code_unique_idx').on(table.userId, table.chargeCodeId),
]);

// ---------------------------------------------------------------------------
// Timesheet Entries (DCAA append-only — NEVER update or delete rows)
// ---------------------------------------------------------------------------

export const timesheetEntries = pgTable('timesheet_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  clinId: uuid('clin_id').references(() => clins.id), // nullable — null for indirect charge entries; DENORMALIZED from charge code for direct entries
  slinId: uuid('slin_id').references(() => slins.id), // nullable — SLIN-level entry; DENORMALIZED from charge code
  indirectCodeId: uuid('indirect_code_id').references(() => indirectChargeCodes.id), // nullable — set for indirect entries
  chargeCodeId: uuid('charge_code_id').references(() => chargeCodes.id), // nullable — set for DIRECT entries (new charge-code model)
  entryDate: date('entry_date', { mode: 'string' }).notNull(),
  hours: varchar('hours', { length: 10 }).notNull().default('0'), // stored as string to preserve exact decimal input
  revisionNumber: integer('revision_number').notNull().default(1),
  changeReasonCode: varchar('change_reason_code', { length: 50 }),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id),
  // feature-plan-certified-outputs.md C1 (CO-D1): provenance, set ONLY at insert (the table is append-only).
  // 'app' = recorded in CadenzPoint; 'migration' = bulk-imported history (createdBy = the importing admin).
  source: varchar('source', { length: 20 }).notNull().default('app'),
  importBatchId: uuid('import_batch_id').references(() => importBatches.id),
  originalMetadata: jsonb('original_metadata'), // imported rows: { enteredBy, enteredAt, reason, comment } verbatim
}, (table) => [
  // Performance index: speeds up the MAX(revision_number) correlated subquery
  // used in every timesheet read query. Without this, each lookup scans the full table.
  // DO NOT REMOVE — this is critical for page load performance.
  index('idx_entries_user_clin_date_rev').on(table.userId, table.clinId, table.entryDate, table.revisionNumber),
  index('idx_entries_user_indirect_date_rev').on(table.userId, table.indirectCodeId, table.entryDate, table.revisionNumber),
  index('idx_entries_user_chargecode_date_rev').on(table.userId, table.chargeCodeId, table.entryDate, table.revisionNumber),
  // feature-plan-calendar-dates.md D2: one cell (user + charge code/indirect code/CLIN + day)
  // can have only one row per revision number — closes the race where two concurrent saves
  // both compute the same "next" revision number (one now fails with a unique violation and
  // the caller retries, instead of silently creating two "revision 2" rows for the same cell).
  uniqueIndex('entries_user_code_date_rev_unique_idx').on(
    table.userId,
    sql`coalesce(${table.chargeCodeId}, ${table.indirectCodeId}, ${table.clinId})`,
    table.entryDate,
    table.revisionNumber,
  ),
]);

// ---------------------------------------------------------------------------
// Timesheet Periods (tracks period lifecycle: draft → submitted → approved/rejected)
// ---------------------------------------------------------------------------

export const timesheetPeriods = pgTable('timesheet_periods', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  periodStart: date('period_start', { mode: 'string' }).notNull(),
  status: periodStatusEnum('status').notNull().default('draft'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedComment: text('submitted_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewComment: text('review_comment'),
  // Period config snapshot — locks the period to the config active when created
  periodType: varchar('period_type', { length: 20 }),        // 'weekly'|'biweekly'|'semimonthly'|'monthly'
  periodNumDays: integer('period_num_days'),                  // number of days in this specific period
  // Structured snapshot of completeness/total-time warnings captured at submission time.
  // Advisory only — never blocks submission. Null if the client sent no snapshot.
  completenessSnapshot: jsonb('completeness_snapshot'),
  // feature-plan-certified-outputs.md C2: incremented by every submission, so an approval applies to exactly the
  // version the reviewer saw (approve/reject are conditional on it).
  submissionCount: integer('submission_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_period_unique_idx').on(table.userId, table.periodStart),
]);

// ---------------------------------------------------------------------------
// Period Events (feature-plan-terms-compliance.md T8 — append-only approval history; R11)
// ---------------------------------------------------------------------------

export const periodEventEnum = pgEnum('period_event', ['submitted', 'approved', 'rejected']);

export const periodEvents = pgTable('period_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  periodId: uuid('period_id').notNull().references(() => timesheetPeriods.id),
  userId: uuid('user_id').notNull().references(() => users.id), // whose period this event is about
  event: periodEventEnum('event').notNull(),
  actorId: uuid('actor_id').references(() => users.id),          // who performed it (approver for approved/rejected)
  comment: text('comment'),
  completenessSnapshot: jsonb('completeness_snapshot'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // feature-plan-certified-outputs.md C1: provenance, insert-time only. For 'migration' rows actor_id is the
  // importing admin; the original reviewer is in original_metadata.
  source: varchar('source', { length: 20 }).notNull().default('app'),
  importBatchId: uuid('import_batch_id').references(() => importBatches.id),
  originalMetadata: jsonb('original_metadata'),
  // C2 (CO-D19): written only on a self-approval event — { selfApproved, activeAdminCount, effectiveDesignee,
  // selfApprovalEnabledAt, selfApprovalEnabledBy }.
  approvalContext: jsonb('approval_context'),
}, (table) => [
  index('idx_period_events_period').on(table.periodId),
]);

// ---------------------------------------------------------------------------
// Import Batches (feature-plan-certified-outputs.md C1 — append-only; one row per migration import batch,
// inserted first in the batch transaction with its final counts; entries/period events reference it)
// ---------------------------------------------------------------------------

export const importBatches = pgTable('import_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  kind: varchar('kind', { length: 10 }).notNull(), // 'entries' | 'periods'
  sourceSystem: varchar('source_system', { length: 100 }).notNull(),
  importedBy: uuid('imported_by').notNull().references(() => users.id),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  fileName: varchar('file_name', { length: 255 }),
  rowCount: integer('row_count').notNull(),
  importedCount: integer('imported_count').notNull(),
  skippedCount: integer('skipped_count').notNull(),
}, (table) => [
  check('import_batches_kind_check', sql`${table.kind} IN ('entries', 'periods')`),
]);

// ---------------------------------------------------------------------------
// Admin Change Log (feature-plan-certified-outputs.md C1 — append-only; written in the same transaction as the
// change it records: charge-code labor category / deactivate / reactivate, workweek start day, approver
// designation, self-approval switched on/off)
// ---------------------------------------------------------------------------

export const adminChangeLog = pgTable('admin_change_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  entity: varchar('entity', { length: 40 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  action: varchar('action', { length: 40 }).notNull(),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_admin_change_log_entity').on(table.entity, table.entityId, table.createdAt),
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
  periodStart: date('period_start', { mode: 'string' }),
  periodEnd: date('period_end', { mode: 'string' }),
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

// ---------------------------------------------------------------------------
// Pay Period Configuration
// ---------------------------------------------------------------------------

export const payPeriodTypeEnum = pgEnum('pay_period_type', [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
]);

export const payPeriodConfig = pgTable('pay_period_config', {
  id: uuid('id').defaultRandom().primaryKey(),
  periodType: payPeriodTypeEnum('period_type').notNull().default('semimonthly'),
  anchorDate: date('anchor_date', { mode: 'string' }).notNull(),
  // For weekly/biweekly: which day of the week starts the period (0=Sun, 1=Mon)
  weekStartDay: integer('week_start_day').notNull().default(1), // Monday
  // Effective-dating: config applies to all periods whose start >= effective_from.
  // The row with the greatest effective_from <= periodStart is authoritative.
  // Existing rows are backfilled to '1900-01-01' so historical periods are unaffected.
  effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Workspace Settings (feature-plan-calendar-dates.md D2/D8) — single-row table holding the
// tenant's IANA timezone, the source of truth for "today" everywhere on the server.
// ---------------------------------------------------------------------------

export const workspaceSettings = pgTable('workspace_settings', {
  id: smallint('id').primaryKey().default(1),
  timezone: text('timezone').notNull().default('America/New_York'),
  // feature-plan-certified-outputs.md C1 (CO-D1): set by the first app submission; while null (or while the
  // founder's control-plane reopen is in force) timesheet history may be imported.
  historyImportClosedAt: timestamp('history_import_closed_at', { withTimezone: true }),
  // C7 (CO-D2): FLSA workweek start, 0 = Sunday (dayjs day()); no default — payroll export refuses until set.
  workweekStartDay: smallint('workweek_start_day'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('workspace_settings_single_row_check', sql`${table.id} = 1`),
  check('workspace_settings_workweek_start_day_check', sql`${table.workweekStartDay} IS NULL OR ${table.workweekStartDay} BETWEEN 0 AND 6`),
]);
