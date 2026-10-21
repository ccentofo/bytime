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
  userAssignments,
  userChargeCodes,
  userLaborCategories,
  payPeriodConfig,
  timesheetPeriods,
  periodEvents,
  notificationPreferences,
  integrationEntityMappings,
  integrationSyncLogs,
  integrationSyncRecords,
} from '@/db/schema';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { InferSelectModel } from 'drizzle-orm';

export interface ExportColumn<T extends PgTable> {
  key: keyof InferSelectModel<T>;
  header: string;
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
  columns: { key: string; header: string }[];
}

function table<T extends PgTable>(file: string, t: T, columns: ExportColumn<T>[]): ExportTableConfig {
  return { file, table: t, columns: columns.map((c) => ({ key: String(c.key), header: c.header })) };
}

/**
 * Tables per T6 §1 baseline + D12 EXPORT_EXTRA_TABLES, exported via the simple
 * select-these-columns-and-paginate-by-id path. `timesheet_entries` (raw + current) is handled
 * separately (src/app/api/export/workspace/route.ts) because it needs resolved human labels and
 * the latest-revision-per-cell query — not a plain column projection.
 *
 * `period_events` (T8) is not here yet — added once that migration lands.
 */
export const EXPORT_TABLES: ExportTableConfig[] = [
  table('users', users, [
    { key: 'id', header: 'id' },
    { key: 'email', header: 'email' },
    { key: 'fullName', header: 'full_name' },
    { key: 'role', header: 'role' },
    { key: 'isActive', header: 'is_active' },
    { key: 'flsaExempt', header: 'flsa_exempt' },
    { key: 'totpEnabled', header: 'totp_enabled' },
    { key: 'passwordChangedAt', header: 'password_changed_at' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('contracts', contracts, [
    { key: 'id', header: 'id' },
    { key: 'contractNumber', header: 'contract_number' },
    { key: 'name', header: 'name' },
    { key: 'description', header: 'description' },
    { key: 'contractType', header: 'contract_type' },
    { key: 'status', header: 'status' },
    { key: 'startDate', header: 'start_date' },
    { key: 'endDate', header: 'end_date' },
    { key: 'fundedValue', header: 'funded_value' },
    { key: 'ceilingValue', header: 'ceiling_value' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('clins', clins, [
    { key: 'id', header: 'id' },
    { key: 'contractId', header: 'contract_id' },
    { key: 'clinNumber', header: 'clin_number' },
    { key: 'description', header: 'description' },
    { key: 'fundedAmount', header: 'funded_amount' },
    { key: 'status', header: 'status' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('slins', slins, [
    { key: 'id', header: 'id' },
    { key: 'clinId', header: 'clin_id' },
    { key: 'slinNumber', header: 'slin_number' },
    { key: 'description', header: 'description' },
    { key: 'fundedAmount', header: 'funded_amount' },
    { key: 'status', header: 'status' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('charge_codes', chargeCodes, [
    { key: 'id', header: 'id' },
    { key: 'code', header: 'code' },
    { key: 'name', header: 'name' },
    { key: 'description', header: 'description' },
    { key: 'clinId', header: 'clin_id' },
    { key: 'slinId', header: 'slin_id' },
    { key: 'laborCategoryId', header: 'labor_category_id' },
    { key: 'classId', header: 'class_id' },
    { key: 'workLocation', header: 'work_location' },
    { key: 'billable', header: 'billable' },
    { key: 'isActive', header: 'is_active' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('cost_classes', costClasses, [
    { key: 'id', header: 'id' },
    { key: 'name', header: 'name' },
    { key: 'isActive', header: 'is_active' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('indirect_charge_codes', indirectChargeCodes, [
    { key: 'id', header: 'id' },
    { key: 'code', header: 'code' },
    { key: 'name', header: 'name' },
    { key: 'category', header: 'category' },
    { key: 'description', header: 'description' },
    { key: 'isActive', header: 'is_active' },
    { key: 'availableToAll', header: 'available_to_all' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('labor_categories', laborCategories, [
    { key: 'id', header: 'id' },
    { key: 'clinId', header: 'clin_id' },
    { key: 'slinId', header: 'slin_id' },
    { key: 'lcatCode', header: 'lcat_code' },
    { key: 'title', header: 'title' },
    { key: 'hourlyRate', header: 'hourly_rate' },
    { key: 'ceilingRate', header: 'ceiling_rate' },
    { key: 'status', header: 'status' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
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
    { key: 'chargeCodeId', header: 'charge_code_id' },
    { key: 'isActive', header: 'is_active' },
    { key: 'assignedAt', header: 'assigned_at' },
    { key: 'assignedBy', header: 'assigned_by' },
  ]),
  table('user_labor_categories', userLaborCategories, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id' },
    { key: 'laborCategoryId', header: 'labor_category_id' },
    { key: 'effectiveDate', header: 'effective_date' },
    { key: 'endDate', header: 'end_date' },
    { key: 'assignedBy', header: 'assigned_by' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('pay_period_config', payPeriodConfig, [
    { key: 'id', header: 'id' },
    { key: 'periodType', header: 'period_type' },
    { key: 'anchorDate', header: 'anchor_date' },
    { key: 'weekStartDay', header: 'week_start_day' },
    { key: 'effectiveFrom', header: 'effective_from' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('timesheet_periods', timesheetPeriods, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id' },
    { key: 'periodStart', header: 'period_start' },
    { key: 'status', header: 'status' },
    { key: 'submittedAt', header: 'submitted_at' },
    { key: 'submittedComment', header: 'submitted_comment' },
    { key: 'reviewedAt', header: 'reviewed_at' },
    { key: 'reviewedBy', header: 'reviewed_by' },
    { key: 'reviewComment', header: 'review_comment' },
    { key: 'periodType', header: 'period_type' },
    { key: 'periodNumDays', header: 'period_num_days' },
    { key: 'completenessSnapshot', header: 'completeness_snapshot' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('period_events', periodEvents, [
    { key: 'id', header: 'id' },
    { key: 'periodId', header: 'period_id' },
    { key: 'userId', header: 'user_id' },
    { key: 'event', header: 'event' },
    { key: 'actorId', header: 'actor_id' },
    { key: 'comment', header: 'comment' },
    { key: 'completenessSnapshot', header: 'completeness_snapshot' },
    { key: 'createdAt', header: 'created_at' },
  ]),
  // D12 EXPORT_EXTRA_TABLES
  table('notification_preferences', notificationPreferences, [
    { key: 'id', header: 'id' },
    { key: 'userId', header: 'user_id' },
    { key: 'emailOnSubmit', header: 'email_on_submit' },
    { key: 'emailOnApprove', header: 'email_on_approve' },
    { key: 'emailOnReject', header: 'email_on_reject' },
    { key: 'emailDailyReminder', header: 'email_daily_reminder' },
    { key: 'emailDeadlineReminder', header: 'email_deadline_reminder' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('integration_entity_mappings', integrationEntityMappings, [
    { key: 'id', header: 'id' },
    { key: 'connectionId', header: 'connection_id' },
    { key: 'entityType', header: 'entity_type' },
    { key: 'bytimeEntityId', header: 'bytime_entity_id' },
    { key: 'bytimeEntityName', header: 'bytime_entity_name' },
    { key: 'externalEntityId', header: 'external_entity_id' },
    { key: 'externalEntityName', header: 'external_entity_name' },
    { key: 'metadata', header: 'metadata' },
    { key: 'createdAt', header: 'created_at' },
    { key: 'updatedAt', header: 'updated_at' },
  ]),
  table('integration_sync_logs', integrationSyncLogs, [
    { key: 'id', header: 'id' },
    { key: 'connectionId', header: 'connection_id' },
    { key: 'syncType', header: 'sync_type' },
    { key: 'periodStart', header: 'period_start' },
    { key: 'periodEnd', header: 'period_end' },
    { key: 'triggeredBy', header: 'triggered_by' },
    { key: 'triggerType', header: 'trigger_type' },
    { key: 'recordsPushed', header: 'records_pushed' },
    { key: 'recordsFailed', header: 'records_failed' },
    { key: 'recordsSkipped', header: 'records_skipped' },
    { key: 'status', header: 'status' },
    { key: 'errorSummary', header: 'error_summary' },
    { key: 'startedAt', header: 'started_at' },
    { key: 'completedAt', header: 'completed_at' },
    { key: 'createdAt', header: 'created_at' },
  ]),
  table('integration_sync_records', integrationSyncRecords, [
    { key: 'id', header: 'id' },
    { key: 'syncLogId', header: 'sync_log_id' },
    { key: 'bytimeEntityType', header: 'bytime_entity_type' },
    { key: 'bytimeEntityId', header: 'bytime_entity_id' },
    { key: 'externalEntityId', header: 'external_entity_id' },
    { key: 'status', header: 'status' },
    { key: 'errorMessage', header: 'error_message' },
    { key: 'requestPayload', header: 'request_payload' },
    { key: 'responsePayload', header: 'response_payload' },
    { key: 'createdAt', header: 'created_at' },
  ]),
];
