import 'server-only';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, gte, inArray, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import { getDb, type ReadDb } from '@/db';
import { chargeCodes, clins, contracts, importBatches, indirectChargeCodes, timesheetEntries, users } from '@/db/schema';
import { getEmployeeScope, requireApprover } from '@/lib/session';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { validateOptionalCalendarDate, validateUUID } from '@/lib/validation';
import { cellCodeLabel, cellKind } from '@/lib/cell-code';
import { provenanceText } from '@/lib/provenance';
import { escapeCsvField } from '@/lib/csv/escape';
import { UserFacingError } from '@/lib/errors';
import type { CalendarDate } from '@/lib/calendar-date';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * The Audit trail's ONE entry filter (feature-plan-ux-people-codes.md §6.2), shared by the list, its count, the
 * summary and the CSV export — so the four always agree. A WHERE over `timesheet_entries` alone: the contract filter is
 * `clin_id IN (SELECT id FROM clins WHERE contract_id = …)`, so no join is needed (the summary has none). Dates are on
 * entry_date (inclusive). Plus the CSV's guarded cursor (§6.5), resolved before any streaming starts.
 */

export interface AuditEntryFilters {
  userId?: string;
  contractId?: string;
  clinId?: string;
  startDate?: CalendarDate;
  endDate?: CalendarDate;
  reasonCode?: string;
  /** "Changed entries only": revision_number ≥ 2 (R3). */
  revisionsOnly?: boolean;
}

/** Validated filters (ids are UUIDs, dates calendar dates) — the error is the user's message. */
export function validAuditFilters(f: AuditEntryFilters | undefined): AuditEntryFilters {
  const v: AuditEntryFilters = {};
  if (!f) return v;
  if (f.userId) v.userId = validateUUID(f.userId, 'Employee');
  if (f.contractId) v.contractId = validateUUID(f.contractId, 'Contract');
  if (f.clinId) v.clinId = validateUUID(f.clinId, 'CLIN');
  v.startDate = validateOptionalCalendarDate(f.startDate, 'Start date');
  v.endDate = validateOptionalCalendarDate(f.endDate, 'End date');
  if (f.reasonCode !== undefined && f.reasonCode !== null && f.reasonCode !== '') {
    if (typeof f.reasonCode !== 'string' || f.reasonCode.length > 40) throw new UserFacingError('Choose a reason.');
    v.reasonCode = f.reasonCode;
  }
  if (f.revisionsOnly === true) v.revisionsOnly = true;
  return v;
}

/** R3: "late" is the same ROW rule as Approvals — an app-recorded revision 1 that carries a reason. */
export const AUDIT_LATE_ROW: SQL = and(
  eq(timesheetEntries.revisionNumber, 1),
  eq(timesheetEntries.source, 'app'),
  isNotNull(timesheetEntries.changeReasonCode),
)!;

/** The WHERE for the scope (an approver's employees, or everyone) and the filters. */
export function auditEntryWhere(db: Pick<ReadDb, 'select'>, scope: 'all' | string[], f: AuditEntryFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (scope !== 'all') conditions.push(inArray(timesheetEntries.userId, scope));
  if (f.userId) conditions.push(eq(timesheetEntries.userId, f.userId));
  if (f.clinId) conditions.push(eq(timesheetEntries.clinId, f.clinId));
  if (f.contractId) {
    conditions.push(inArray(timesheetEntries.clinId, db.select({ id: clins.id }).from(clins).where(eq(clins.contractId, f.contractId))));
  }
  if (f.startDate) conditions.push(gte(timesheetEntries.entryDate, f.startDate));
  if (f.endDate) conditions.push(lte(timesheetEntries.entryDate, f.endDate));
  if (f.reasonCode) conditions.push(eq(timesheetEntries.changeReasonCode, f.reasonCode));
  if (f.revisionsOnly) conditions.push(gte(timesheetEntries.revisionNumber, 2));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

// ── The CSV (§6.5) ──────────────────────────────────────────────────────────────────────────────────────────────

export const AUDIT_CSV_MAX_ROWS = 50_000;
export const AUDIT_CSV_BATCH = 1_000;
export const AUDIT_CSV_HEADER = [
  'Work date', 'Employee', 'Employee email', 'Contract number', 'CLIN', 'Charge code', 'Hours', 'Version',
  'Reason code', 'Comment', 'Entered at', 'Entered by', 'Source',
] as const;

const importer = alias(users, 'audit_csv_importer');
const enteredBy = alias(users, 'audit_csv_entered_by');

export interface AuditExportCursor {
  /** The number of rows the export will write (scope + filters). */
  count: () => Promise<number>;
  /** The next batch after `lastId` (null = the first), newest first, already encoded as CSV lines. */
  batch: (lastId: string | null) => Promise<{ lines: string[]; lastId: string | null }>;
}

/**
 * The export's guarded, scoped cursor. Everything request-bound — the approver guard, the employee scope, the database
 * client, the workspace timezone and the WHERE — is resolved HERE, before the route builds its stream; `batch` closes
 * over them and never reads the session, headers or settings again. Not a server action (server-only module).
 */
export async function getAuditExportCursor(filters: AuditEntryFilters): Promise<AuditExportCursor> {
  const actor = await requireApprover();
  const f = validAuditFilters(filters);
  const scope = await getEmployeeScope(actor);
  const db = await getDb();
  const tz = await getWorkspaceTimezone();
  const empty = scope !== 'all' && scope.length === 0;
  const where = auditEntryWhere(db, scope, f);

  return {
    count: async () => {
      if (empty) return 0;
      const [row] = await db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(timesheetEntries).where(where);
      return row?.n ?? 0;
    },
    batch: async (lastId) => {
      if (empty) return { lines: [], lastId: null };
      // The keyset cursor stays in SQL: created_at has microsecond precision and one save shares it, so a JS Date
      // (milliseconds) would silently drop rows. Compare against the last row's own stored values.
      const after = lastId
        ? sql`(${timesheetEntries.createdAt}, ${timesheetEntries.id}) < (SELECT te_cursor.created_at, te_cursor.id FROM timesheet_entries te_cursor WHERE te_cursor.id = ${lastId})`
        : undefined;
      const rows = await db
        .select({
          id: timesheetEntries.id,
          entryDate: timesheetEntries.entryDate,
          userName: users.fullName,
          userEmail: users.email,
          contractNumber: contracts.contractNumber,
          clinNumber: clins.clinNumber,
          chargeCodeId: timesheetEntries.chargeCodeId,
          indirectCodeId: timesheetEntries.indirectCodeId,
          clinId: timesheetEntries.clinId,
          chargeCode: chargeCodes.code,
          indirectCode: indirectChargeCodes.code,
          hours: timesheetEntries.hours,
          revisionNumber: timesheetEntries.revisionNumber,
          changeReasonCode: timesheetEntries.changeReasonCode,
          comment: timesheetEntries.comment,
          createdAt: timesheetEntries.createdAt,
          createdByName: enteredBy.fullName,
          source: timesheetEntries.source,
          originalMetadata: timesheetEntries.originalMetadata,
          importSourceSystem: importBatches.sourceSystem,
          importedAt: importBatches.importedAt,
          importedByName: importer.fullName,
        })
        .from(timesheetEntries)
        .innerJoin(users, eq(timesheetEntries.userId, users.id))
        .leftJoin(enteredBy, eq(timesheetEntries.createdBy, enteredBy.id))
        .leftJoin(chargeCodes, eq(timesheetEntries.chargeCodeId, chargeCodes.id))
        .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
        .leftJoin(contracts, eq(clins.contractId, contracts.id))
        .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
        .leftJoin(importBatches, eq(timesheetEntries.importBatchId, importBatches.id))
        .leftJoin(importer, eq(importBatches.importedBy, importer.id))
        .where(and(where, after))
        .orderBy(desc(timesheetEntries.createdAt), desc(timesheetEntries.id))
        .limit(AUDIT_CSV_BATCH);
      return { lines: rows.map((r) => auditCsvLine(r, tz)), lastId: rows.length === AUDIT_CSV_BATCH ? rows[rows.length - 1].id : null };
    },
  };
}

type CsvRow = {
  entryDate: string; userName: string; userEmail: string; contractNumber: string | null; clinNumber: string | null;
  chargeCodeId: string | null; indirectCodeId: string | null; clinId: string | null; chargeCode: string | null; indirectCode: string | null;
  hours: string; revisionNumber: number; changeReasonCode: string | null; comment: string | null; createdAt: Date;
  createdByName: string | null; source: string; originalMetadata: unknown; importSourceSystem: string | null; importedAt: Date | null; importedByName: string | null;
};

/** One CSV line: the raw reason code; the entered-at instant as ISO 8601 with the workspace zone's offset; every field escaped. */
export function auditCsvLine(r: CsvRow, tz: string): string {
  const kind = cellKind(r);
  const provenance = provenanceText(r as Parameters<typeof provenanceText>[0]);
  return [
    r.entryDate, r.userName, r.userEmail, r.contractNumber ?? '', r.clinNumber ?? '', cellCodeLabel({ kind, ...r, indirectCategory: null }), r.hours,
    String(r.revisionNumber), r.changeReasonCode ?? '', r.comment ?? '', dayjs(r.createdAt).tz(tz).format('YYYY-MM-DDTHH:mm:ss.SSSZ'),
    provenance ?? r.createdByName ?? '', r.source,
  ].map((v) => escapeCsvField(v)).join(',');
}
