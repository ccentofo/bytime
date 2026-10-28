/**
 * feature-plan-terms-compliance.md T6 (R8): the full workspace export is an EXPLICIT column
 * allowlist per table, not a denylist — a future column (especially a secret one) is excluded
 * by default until someone deliberately adds it here. Never add `users.password_hash`,
 * `totp_secret`, `totp_recovery_codes`, `totp_last_used_step`, `session_version`,
 * `api_keys.key_hash`, or any integration token column — see the blueprint's "Never exported"
 * list. `api_keys`, `login_attempts`, and `password_reset_tokens` are excluded entirely
 * (security records, not Customer Data — D12).
 */
import {
  users,
  contracts,
  clins,
  slins,
  chargeCodes,
  costClasses,
  indirectChargeCodes,
  laborCategories,
  laborCategoryRates,
  chargeCodeLaborCategories,
  userAssignments,
  userChargeCodes,
  userLaborCategories,
  payPeriodConfig,
  timesheetPeriods,
  timesheetNotes,
  periodEvents,
  notificationPreferences,
  integrationEntityMappings,
  integrationSyncLogs,
  integrationSyncRecords,
  workspaceSettings,
  importBatches,
  adminChangeLog,
} from '@/db/schema';
import type { PgTable } from 'drizzle-orm/pg-core';
import { sql, type InferSelectModel, type SQL } from 'drizzle-orm';

export interface ExportColumn<T extends PgTable> {
  key: keyof InferSelectModel<T>;
  header: string;
  /** What the column means (README data dictionary). Optional only when COMMON_DESCRIPTIONS covers the header. */
  description?: string;
}

/**
 * Non-generic storage shape: `table()` below checks `key` against the specific table's real
 * columns at the point each entry is authored, but once built there's no need to carry each
 * table's distinct type around — every consumer just wants `{file, table, columns}` generically.
 */
export interface ExportTableConfig {
  /** CSV filename, without extension. */
  file: string;
  table: PgTable;
  /** `expr`: a DERIVED column (computed in the export query, not stored) — its `key` is the header. */
  columns: { key: string; header: string; description: string; expr?: SQL }[];
}

/** A derived (computed, read-only) column appended after a table's real columns. */
export interface DerivedColumn {
  header: string;
  description: string;
  expr: SQL;
}

/** Shared meanings for columns that recur across tables. A per-column `description` overrides these. */
const COMMON_DESCRIPTIONS: Record<string, string> = {
  id: 'Unique identifier of this row. Other files refer to it from their `*_id` columns.',
  created_at: 'When this row was created (UTC).',
  updated_at: 'When this row was last changed (UTC).',
  is_active: 'true if the record is in use; false if it was deactivated (records are deactivated, not deleted).',
  user_id: 'The employee this row belongs to (users.csv id).',
  clin_id: 'The contract line item (clins.csv id), if any.',
  slin_id: 'The sub-line item (slins.csv id), if any.',
  assigned_at: 'When the assignment was made (UTC).',
  assigned_by: 'Who made the assignment (users.csv id).',
  description: 'Free-text description entered by your team.',
  name: 'Display name.',
  status: 'Record status: active, inactive or closed.',
  funded_amount: 'Funded (obligated) amount, as entered (text, no currency conversion).',
  connection_id: 'The accounting/payroll integration this row belongs to (the connection itself is not exported: it holds credentials).',
  completeness_snapshot: 'JSON snapshot of the completeness / total-time warnings shown at submission (advisory only; blank if none).',
};

function table<T extends PgTable>(file: string, t: T, columns: ExportColumn<T>[], derived: DerivedColumn[] = []): ExportTableConfig {
  return {
    file,
    table: t,
    columns: [
      ...columns.map((c) => ({
        key: String(c.key),
        header: c.header,
        description: c.description ?? COMMON_DESCRIPTIONS[c.header] ?? '',
      })),
      ...derived.map((d) => ({ key: d.header, header: d.header, description: d.description, expr: d.expr })),
    ],
  };
}

/**
 * certified-outputs C2/C8: "Self-approved" as a derived column — the same rule as approvalLabel
 * (src/server/internal/approval-label.ts): the period's latest decision event matching its status (else
 * reviewed_by) was made by the employee themselves, and was not an imported approval.
 */
const PERIOD_SELF_APPROVED = sql<boolean>`COALESCE(${timesheetPeriods.status} = 'approved'
  AND COALESCE((SELECT pe.source FROM period_events pe WHERE pe.period_id = ${timesheetPeriods.id} AND pe.event = 'approved'
    ORDER BY pe.created_at DESC LIMIT 1), 'app') <> 'migration'
  AND COALESCE((SELECT pe.actor_id FROM period_events pe WHERE pe.period_id = ${timesheetPeriods.id} AND pe.event = 'approved'
    ORDER BY pe.created_at DESC LIMIT 1), ${timesheetPeriods.reviewedBy}) = ${timesheetPeriods.userId}, false)`;
const EVENT_SELF_APPROVED = sql<boolean>`COALESCE(${periodEvents.event} = 'approved' AND ${periodEvents.source} <> 'migration'
  AND ${periodEvents.actorId} = ${periodEvents.userId}, false)`;
const SELF_APPROVED_DESCRIPTION = 'Derived: true when the employee approved their own timesheet (sole-admin self-approval, shown as Self-approved in the app). Never true for an imported approval.';
const SOURCE_DESCRIPTION = 'app = recorded in CadenzPoint; migration = imported from another system during onboarding (never typed here by the employee).';
const IMPORT_BATCH_DESCRIPTION = 'For imported rows: the import (import_batches.csv id); blank otherwise.';

/**
 * Tables per T6 §1 baseline + D12 EXPORT_EXTRA_TABLES, exported via the simple
 * select-these-columns-and-paginate-by-id path. `timesheet_entries` (raw + current) is handled
 * separately (src/app/api/export/workspace/route.ts) because it needs resolved human labels and
 * the latest-revision-per-cell query — not a plain column projection.
 *
 */
export const EXPORT_TABLES: ExportTableConfig[] = [
  table('users', users, [
    { key: 'id', header: 'id' },
    { key: 'email', header: 'email', description: 'Sign-in email address.' },
    { key: 'fullName', header: 'full_name', description: 'Full name.' },
    { key: 'role', header: 'role', description: 'Permission level: admin, supervisor or employee.' },
    { key: 'isActive', header: 'is_active' },
    { key: 'flsaExempt', header: 'flsa_exempt', description: 'true for FLSA-exempt (salaried) employees, who must still record all hours worked.' },
    { key: 'approverId', header: 'approver_id', description: 'Supervisors and admins only: their designated approver (users.csv id); blank if none.' },
    { key: 'totpEnabled', header: 'totp_enabled', description: 'true if the user turned on two-factor authentication (the secret itself is never exported).' },
    { key: 'passwordChangedAt', header: 'password_changed_at', description: 'When the user last changed their password (UTC). The password itself is never exported.' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('contracts', contracts, [
    { key: 'id', header: 'id' },
    { key: 'contractNumber', header: 'contract_number', description: 'Contract number as entered (unique within the workspace).' },
    { key: 'name', header: 'name', description: 'Contract name.' },
    { key: 'description', header: 'description' },
    { key: 'contractType', header: 'contract_type', description: 'prime or sub (subcontract).' },
    { key: 'status', header: 'status' },
    { key: 'startDate', header: 'start_date', description: 'Period of performance start (calendar date, YYYY-MM-DD).' },
    { key: 'endDate', header: 'end_date', description: 'Period of performance end (calendar date, YYYY-MM-DD).' },
    { key: 'fundedValue', header: 'funded_value', description: 'Currently funded (obligated) value, as entered.' },
    { key: 'ceilingValue', header: 'ceiling_value', description: 'Contract ceiling value, as entered.' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('clins', clins, [
    { key: 'id', header: 'id' },
    { key: 'contractId', header: 'contract_id', description: 'The contract this line item belongs to (contracts.csv id).' },
    { key: 'clinNumber', header: 'clin_number', description: 'Contract line item number, as entered.' },
    { key: 'description', header: 'description' },
    { key: 'fundedAmount', header: 'funded_amount' },
    { key: 'status', header: 'status' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('slins', slins, [
    { key: 'id', header: 'id' },
    { key: 'clinId', header: 'clin_id', description: 'The line item this sub-line belongs to (clins.csv id).' },
    { key: 'slinNumber', header: 'slin_number', description: 'Sub-line item number, as entered.' },
    { key: 'description', header: 'description' },
    { key: 'fundedAmount', header: 'funded_amount' },
    { key: 'status', header: 'status' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('charge_codes', chargeCodes, [
    { key: 'id', header: 'id' },
    { key: 'code', header: 'code', description: 'The charge code employees select on their timesheet.' },
    { key: 'name', header: 'name', description: 'Charge code name.' },
    { key: 'description', header: 'description' },
    { key: 'clinId', header: 'clin_id' },
    { key: 'slinId', header: 'slin_id' },
    { key: 'laborCategoryId', header: 'labor_category_id', description: 'Starting labor category — applies to days before the first change in charge_code_labor_categories.csv (labor_categories.csv id), if any.' },
    { key: 'classId', header: 'class_id', description: 'Cost class (cost_classes.csv id), if any.' },
    { key: 'workLocation', header: 'work_location', description: 'onsite, telework or other (blank if not set).' },
    { key: 'billable', header: 'billable', description: 'true if time on this code is billable to the customer.' },
    { key: 'isActive', header: 'is_active' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('cost_classes', costClasses, [
    { key: 'id', header: 'id' },
    { key: 'name', header: 'name', description: 'Cost class name (groups charge codes, e.g. for accounting classes).' },
    { key: 'isActive', header: 'is_active' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('indirect_charge_codes', indirectChargeCodes, [
    { key: 'id', header: 'id' },
    { key: 'code', header: 'code', description: 'Indirect charge code employees select (overhead, G&A, leave, etc.).' },
    { key: 'name', header: 'name', description: 'Indirect charge code name.' },
    { key: 'category', header: 'category', description: 'overhead, ga (general and administrative), irad, bp (bid and proposal), leave, or unallowable.' },
    { key: 'description', header: 'description' },
    { key: 'isActive', header: 'is_active' },
    { key: 'availableToAll', header: 'available_to_all', description: 'true if every employee may charge it; false if only assigned employees may.' },
    { key: 'leavePayType', header: 'leave_pay_type', description: 'Leave codes only: how the hours are paid in payroll exports — pto, sick, holiday or unpaid.' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('labor_categories', laborCategories, [
    { key: 'id', header: 'id' },
    { key: 'clinId', header: 'clin_id' },
    { key: 'slinId', header: 'slin_id' },
    { key: 'lcatCode', header: 'lcat_code', description: 'Labor category code.' },
    { key: 'title', header: 'title', description: 'Labor category title.' },
    { key: 'hourlyRate', header: 'hourly_rate', description: 'Starting rate — applies to days before the first change in labor_category_rates.csv.' },
    { key: 'ceilingRate', header: 'ceiling_rate', description: 'Starting rate — applies to days before the first change in labor_category_rates.csv.' },
    { key: 'status', header: 'status' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('labor_category_rates', laborCategoryRates, [
    { key: 'id', header: 'id', description: 'Rate change id.' },
    { key: 'laborCategoryId', header: 'labor_category_id', description: 'The labor category (labor_categories.csv id).' },
    { key: 'effectiveDate', header: 'effective_date', description: 'First day this rate applies (inclusive); it applies until the next change.' },
    { key: 'hourlyRate', header: 'hourly_rate', description: 'Hourly rate from effective_date.' },
    { key: 'ceilingRate', header: 'ceiling_rate', description: 'Ceiling rate from effective_date (blank = none).' },
    { key: 'createdBy', header: 'created_by', description: 'User who added the change (users.csv id).' },
    { key: 'createdAt', header: 'created_at', description: 'When the row was created / last corrected (UTC).' },
    { key: 'updatedAt', header: 'updated_at', description: 'When the row was created / last corrected (UTC).' },
  ]),
  table('charge_code_labor_categories', chargeCodeLaborCategories, [
    { key: 'id', header: 'id', description: 'Category change id.' },
    { key: 'chargeCodeId', header: 'charge_code_id', description: 'The charge code (charge_codes.csv id).' },
    { key: 'effectiveDate', header: 'effective_date', description: 'First day this labor category applies (inclusive); it applies until the next change.' },
    { key: 'laborCategoryId', header: 'labor_category_id', description: 'Labor category from effective_date (labor_categories.csv id).' },
    { key: 'createdBy', header: 'created_by', description: 'User who added the change (users.csv id).' },
    { key: 'createdAt', header: 'created_at', description: 'When the row was created / last corrected (UTC).' },
    { key: 'updatedAt', header: 'updated_at', description: 'When the row was created / last corrected (UTC).' },
  ]),
  table('user_assignments', userAssignments, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id' },
    { key: 'clinId', header: 'clin_id' },
    { key: 'slinId', header: 'slin_id' },
    { key: 'isActive', header: 'is_active' },
    { key: 'assignedAt', header: 'assigned_at' },
    { key: 'assignedBy', header: 'assigned_by' },
  ]),
  table('user_charge_codes', userChargeCodes, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id' },
    { key: 'chargeCodeId', header: 'charge_code_id', description: 'The charge code assigned to the employee (charge_codes.csv id).' },
    { key: 'isActive', header: 'is_active' },
    { key: 'assignedAt', header: 'assigned_at' },
    { key: 'assignedBy', header: 'assigned_by' },
  ]),
  table('user_labor_categories', userLaborCategories, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id' },
    { key: 'laborCategoryId', header: 'labor_category_id', description: 'The labor category assigned (labor_categories.csv id).' },
    { key: 'effectiveDate', header: 'effective_date', description: 'First day the assignment applies (YYYY-MM-DD).' },
    { key: 'endDate', header: 'end_date', description: 'Last day the assignment applies (YYYY-MM-DD; blank if open-ended).' },
    { key: 'assignedBy', header: 'assigned_by' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('pay_period_config', payPeriodConfig, [
    { key: 'id', header: 'id' },
    { key: 'periodType', header: 'period_type', description: 'weekly, biweekly, semimonthly or monthly.' },
    { key: 'anchorDate', header: 'anchor_date', description: 'A date on which a period starts; other periods are counted from it (YYYY-MM-DD).' },
    { key: 'weekStartDay', header: 'week_start_day', description: 'Weekly/biweekly only: the day periods start (0 = Sunday, 1 = Monday, ...).' },
    { key: 'effectiveFrom', header: 'effective_from', description: 'This configuration applies to periods starting on or after this date (YYYY-MM-DD); the latest applicable row wins.' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('timesheet_periods', timesheetPeriods, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id', description: 'The employee whose timesheet period this is (users.csv id).' },
    { key: 'periodStart', header: 'period_start', description: 'First day of the period (YYYY-MM-DD).' },
    { key: 'status', header: 'status', description: 'draft, submitted, approved or rejected.' },
    { key: 'submittedAt', header: 'submitted_at', description: 'When the employee last submitted (UTC).' },
    { key: 'submittedComment', header: 'submitted_comment', description: 'Comment the employee entered on submission.' },
    { key: 'reviewedAt', header: 'reviewed_at', description: 'When a supervisor or admin last approved or rejected it (UTC).' },
    { key: 'reviewedBy', header: 'reviewed_by', description: 'Who last approved or rejected it (users.csv id).' },
    { key: 'reviewComment', header: 'review_comment', description: 'Comment the reviewer entered.' },
    { key: 'periodType', header: 'period_type', description: 'The pay-period type in force when the period was created.' },
    { key: 'periodNumDays', header: 'period_num_days', description: 'Number of days in this period.' },
    { key: 'completenessSnapshot', header: 'completeness_snapshot' },
    { key: 'submissionCount', header: 'submission_count', description: 'How many times this timesheet has been submitted (an approval applies to the version the reviewer saw).' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ], [{ header: 'self_approved', description: SELF_APPROVED_DESCRIPTION, expr: PERIOD_SELF_APPROVED }]),
  table('period_events', periodEvents, [
    { key: 'id', header: 'id' },
    { key: 'periodId', header: 'period_id', description: 'The timesheet period (timesheet_periods.csv id).' },
    { key: 'userId', header: 'user_id', description: 'The employee whose period this event is about (users.csv id).' },
    { key: 'event', header: 'event', description: 'submitted, approved or rejected. This file is the full, append-only approval history.' },
    { key: 'actorId', header: 'actor_id', description: 'Who performed the action (users.csv id). For imported rows (source = migration) this is the admin who ran the import; the original reviewer is in original_metadata.' },
    { key: 'comment', header: 'comment', description: 'Comment entered with the action.' },
    { key: 'completenessSnapshot', header: 'completeness_snapshot' },
    { key: 'createdAt', header: 'created_at', description: 'When the action happened (UTC).' },
    { key: 'source', header: 'source', description: SOURCE_DESCRIPTION },
    { key: 'importBatchId', header: 'import_batch_id', description: IMPORT_BATCH_DESCRIPTION },
    { key: 'originalMetadata', header: 'original_metadata', description: 'For imported rows: the original reviewer, dates and comment from the source file, as data (JSON).' },
    { key: 'approvalContext', header: 'approval_context', description: 'Self-approvals only: the active-admin count at that moment and when self-approval was last switched on (JSON).' },
  ], [{ header: 'self_approved', description: SELF_APPROVED_DESCRIPTION, expr: EVENT_SELF_APPROVED }]),
  // feature-plan-ux-timesheet.md A4.1: every revision of every note (the table is append-only, like the entries).
  table('timesheet_notes', timesheetNotes, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id', description: 'The employee whose timesheet the note is on (users.csv id).' },
    { key: 'entryDate', header: 'entry_date', description: 'The day the note is about (calendar date, YYYY-MM-DD).' },
    { key: 'chargeCodeId', header: 'charge_code_id', description: 'The charge code row the note is on (charge_codes.csv id); blank for indirect or CLIN-only rows.' },
    { key: 'indirectCodeId', header: 'indirect_code_id', description: 'The indirect code row the note is on (indirect_charge_codes.csv id); blank otherwise.' },
    { key: 'clinId', header: 'clin_id', description: 'Legacy CLIN-only rows: the line item the note is on (clins.csv id); blank otherwise.' },
    { key: 'body', header: 'body', description: 'The note text as of this revision. Blank means the note was removed at this revision.' },
    { key: 'revisionNumber', header: 'revision_number', description: 'Revision of this note for this day and row, starting at 1. The highest revision is the current note; earlier ones are its history.' },
    { key: 'createdBy', header: 'created_by', description: 'Who wrote this revision (users.csv id).' },
    { key: 'createdAt', header: 'created_at', description: 'When this revision was saved (UTC).' },
  ]),
  table('import_batches', importBatches, [
    { key: 'id', header: 'id' },
    { key: 'kind', header: 'kind', description: 'entries (time entries) or periods (timesheet periods and their approvals).' },
    { key: 'sourceSystem', header: 'source_system', description: 'The system the history was imported from, as entered by the admin.' },
    { key: 'importedBy', header: 'imported_by', description: 'The admin who ran the import (users.csv id).' },
    { key: 'importedAt', header: 'imported_at', description: 'When the import ran (UTC).' },
    { key: 'fileName', header: 'file_name', description: 'The uploaded file name, if given.' },
    { key: 'rowCount', header: 'row_count', description: 'Rows in this batch.' },
    { key: 'importedCount', header: 'imported_count', description: 'Rows inserted.' },
    { key: 'skippedCount', header: 'skipped_count', description: 'Rows not inserted.' },
  ]),
  table('admin_change_log', adminChangeLog, [
    { key: 'id', header: 'id' },
    { key: 'actorId', header: 'actor_id', description: 'Who made the change (users.csv id).' },
    { key: 'entity', header: 'entity', description: 'What was changed: charge_code, user, self_approval, workspace_settings.' },
    { key: 'entityId', header: 'entity_id', description: 'Which record (its id in the matching file; all zeros for workspace_settings).' },
    { key: 'action', header: 'action', description: 'The change, e.g. labor_category_changed, deactivated, reactivated, approver_changed, enabled, disabled, workweek_start_day_changed.' },
    { key: 'oldValue', header: 'old_value', description: 'The value before the change (JSON).' },
    { key: 'newValue', header: 'new_value', description: 'The value after the change (JSON).' },
    { key: 'createdAt', header: 'created_at', description: 'When the change was made (UTC). This file is append-only.' },
  ]),
  table('workspace_settings', workspaceSettings, [
    { key: 'id', header: 'id', description: 'Always 1 (single settings row).' },
    { key: 'timezone', header: 'timezone', description: 'The workspace time zone (IANA name, e.g. America/New_York). Calendar dates in this export are days in this zone.' },
    { key: 'historyImportClosedAt', header: 'history_import_closed_at', description: 'When timesheet-history import closed (the first submitted timesheet), UTC; blank while still open.' },
    { key: 'workweekStartDay', header: 'workweek_start_day', description: 'FLSA workweek start (0 = Sunday … 6 = Saturday) used by payroll exports; blank if not set.' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  // D12 EXPORT_EXTRA_TABLES
  table('notification_preferences', notificationPreferences, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id' },
    { key: 'emailOnSubmit', header: 'email_on_submit', description: 'Email when a timesheet is submitted for review.' },
    { key: 'emailOnApprove', header: 'email_on_approve', description: 'Email when this employee\'s timesheet is approved.' },
    { key: 'emailOnReject', header: 'email_on_reject', description: 'Email when this employee\'s timesheet is rejected.' },
    { key: 'emailDailyReminder', header: 'email_daily_reminder', description: 'Daily time-entry reminder email.' },
    { key: 'emailDeadlineReminder', header: 'email_deadline_reminder', description: 'Submission-deadline reminder email.' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('integration_entity_mappings', integrationEntityMappings, [
    { key: 'id', header: 'id' },
    { key: 'connectionId', header: 'connection_id' },
    { key: 'entityType', header: 'entity_type', description: 'What kind of record is mapped (e.g. employee, charge code).' },
    { key: 'bytimeEntityId', header: 'bytime_entity_id', description: 'The CadenzPoint record id.' },
    { key: 'bytimeEntityName', header: 'bytime_entity_name', description: 'The CadenzPoint record name when mapped.' },
    { key: 'externalEntityId', header: 'external_entity_id', description: 'The matching record id in the external system.' },
    { key: 'externalEntityName', header: 'external_entity_name', description: 'The matching record name in the external system.' },
    { key: 'metadata', header: 'metadata', description: 'Extra mapping details (JSON).' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('integration_sync_logs', integrationSyncLogs, [
    { key: 'id', header: 'id' },
    { key: 'connectionId', header: 'connection_id' },
    { key: 'syncType', header: 'sync_type', description: 'What was synced, e.g. timesheet_push.' },
    { key: 'periodStart', header: 'period_start', description: 'First day of the synced range (YYYY-MM-DD).' },
    { key: 'periodEnd', header: 'period_end', description: 'Last day of the synced range (YYYY-MM-DD).' },
    { key: 'triggeredBy', header: 'triggered_by', description: 'Who started the sync (users.csv id), if a person did.' },
    { key: 'triggerType', header: 'trigger_type', description: 'manual, auto or retry.' },
    { key: 'recordsPushed', header: 'records_pushed', description: 'Records sent successfully.' },
    { key: 'recordsFailed', header: 'records_failed', description: 'Records that failed.' },
    { key: 'recordsSkipped', header: 'records_skipped', description: 'Records skipped (e.g. already synced).' },
    { key: 'status', header: 'status', description: 'pending, running, success, partial or failed.' },
    { key: 'errorSummary', header: 'error_summary', description: 'Summary of errors, if any.' },
    { key: 'startedAt', header: 'started_at', description: 'When the sync started (UTC).' },
    { key: 'completedAt', header: 'completed_at', description: 'When the sync finished (UTC).' },
    { key: 'createdAt', header: 'created_at' },
  ]),
  table('integration_sync_records', integrationSyncRecords, [
    { key: 'id', header: 'id' },
    { key: 'syncLogId', header: 'sync_log_id', description: 'The sync run (integration_sync_logs.csv id).' },
    { key: 'bytimeEntityType', header: 'bytime_entity_type', description: 'What kind of CadenzPoint record was sent.' },
    { key: 'bytimeEntityId', header: 'bytime_entity_id', description: 'Which CadenzPoint record(s) were sent (an id or composite key).' },
    { key: 'externalEntityId', header: 'external_entity_id', description: 'The id the external system assigned, if any.' },
    { key: 'status', header: 'status', description: 'pending, running, success, partial or failed.' },
    { key: 'errorMessage', header: 'error_message', description: 'Error returned by the external system, if any.' },
    { key: 'requestPayload', header: 'request_payload', description: 'The data sent (JSON).' },
    { key: 'responsePayload', header: 'response_payload', description: 'The external system response (JSON).' },
    { key: 'createdAt', header: 'created_at' },
  ]),
];
