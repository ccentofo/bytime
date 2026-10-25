'use server';

import { getDb } from '@/db';
import {
  timesheetEntries, users, clins, contracts, slins, userAssignments, chargeCodes, indirectChargeCodes, importBatches,
  periodEvents, timesheetPeriods,
} from '@/db/schema';
import { eq, and, gte, lt, lte, desc, sql, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { requireApprover, getEmployeeScope, assertCanAccessEmployee } from '@/lib/session';
import { addDays, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { cellCodeLabel, cellKind, type CellKind } from '@/lib/cell-code';
import { indirectCategoryLabel } from '@/lib/indirect-categories';
import { provenanceText } from '@/lib/provenance';
import { validateUUID } from '@/lib/validation';
import { periodEventLabel } from '@/server/internal/approval-label';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';

/** The importing admin (import_batches.imported_by), for provenance labels. */
const importer = alias(users, 'importer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  /** C6: the true cell code COALESCE(charge_code_id, indirect_code_id, clin_id), its kind and label. */
  cellCode: string;
  kind: CellKind;
  codeLabel: string;
  chargeCodeId: string | null;
  clinId: string | null;
  indirectCodeId: string | null;
  /** Null for indirect entries (no CLIN / contract). */
  clinNumber: string | null;
  contractName: string | null;
  contractNumber: string | null;
  slinNumber: string | null;
  /** Indirect entries: the category's display name. */
  indirectCategory: string | null;
  /** C1 "Display": the import label for migrated / legacy-imported rows, else null. */
  provenance: string | null;
  entryDate: CalendarDate;
  hours: string;
  revisionNumber: number;
  changeReasonCode: string | null;
  comment: string | null;
  createdAt: Date;
  createdById: string | null;
  createdByName: string | null;
}

export interface AuditFilters {
  userId?: string;
  contractId?: string;
  clinId?: string;
  startDate?: CalendarDate;
  endDate?: CalendarDate;
  reasonCode?: string;
  revisionsOnly?: boolean; // if true, only show entries where revision_number > 1
}

export interface CellRevisionHistory {
  userId: string;
  userName: string;
  cellCode: string;
  kind: CellKind;
  codeLabel: string;
  clinNumber: string | null;
  contractName: string | null;
  indirectCategory: string | null;
  entryDate: CalendarDate;
  revisions: Array<{
    id: string;
    hours: string;
    revisionNumber: number;
    changeReasonCode: string | null;
    comment: string | null;
    createdAt: Date;
    createdByName: string | null;
    /** C1 "Display": the import label, else null. */
    provenance: string | null;
  }>;
}

/** A period event (submitted / approved / rejected) in the audit trail, labelled by the one approval helper. */
export interface AuditPeriodEvent {
  id: string;
  userId: string;
  userName: string;
  periodStart: CalendarDate;
  event: 'submitted' | 'approved' | 'rejected';
  text: string;
  selfApproved: boolean;
  /** Self-approvals: the recorded context (active admins at the time, last switch-on). */
  context: string | null;
  comment: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Audit Queries — approver only (admin: unrestricted; supervisor: scoped to
// employees sharing an active CLIN assignment with them, per getEmployeeScope).
// ---------------------------------------------------------------------------

/**
 * Get audit entries with filters. Returns all timesheet entries matching
 * the provided filter criteria, ordered by most recent first.
 * Limits to 500 rows to prevent overwhelming the UI.
 */
export async function getAuditEntries(filters: AuditFilters): Promise<AuditEntry[]> {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  if (scope !== 'all' && scope.length === 0) return [];

  const db = await getDb();

  const conditions = [];

  if (scope !== 'all') {
    conditions.push(inArray(timesheetEntries.userId, scope));
  }
  if (filters.userId) {
    conditions.push(eq(timesheetEntries.userId, filters.userId));
  }
  if (filters.clinId) {
    conditions.push(eq(timesheetEntries.clinId, filters.clinId));
  }
  if (filters.startDate) {
    conditions.push(gte(timesheetEntries.entryDate, parseCalendarDate(filters.startDate)));
  }
  if (filters.endDate) {
    // endDate is inclusive, so add 1 day for lt comparison
    conditions.push(lt(timesheetEntries.entryDate, addDays(parseCalendarDate(filters.endDate), 1)));
  }
  if (filters.reasonCode) {
    conditions.push(eq(timesheetEntries.changeReasonCode, filters.reasonCode));
  }
  if (filters.revisionsOnly) {
    conditions.push(gte(timesheetEntries.revisionNumber, 2));
  }
  if (filters.contractId) {
    conditions.push(eq(contracts.id, filters.contractId));
  }

  // C6: LEFT JOINs — indirect entries (no CLIN) are included; the code shown is the true cell code.
  const rows = await db
    .select({
      id: timesheetEntries.id,
      userId: timesheetEntries.userId,
      userName: users.fullName,
      userEmail: users.email,
      chargeCodeId: timesheetEntries.chargeCodeId,
      clinId: timesheetEntries.clinId,
      indirectCodeId: timesheetEntries.indirectCodeId,
      chargeCode: chargeCodes.code,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
      indirectCode: indirectChargeCodes.code,
      indirectCategory: indirectChargeCodes.category,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
      changeReasonCode: timesheetEntries.changeReasonCode,
      comment: timesheetEntries.comment,
      createdAt: timesheetEntries.createdAt,
      createdById: timesheetEntries.createdBy,
      createdByName: sql<string | null>`(SELECT full_name FROM users WHERE id = ${timesheetEntries.createdBy})`,
      source: timesheetEntries.source,
      originalMetadata: timesheetEntries.originalMetadata,
      importSourceSystem: importBatches.sourceSystem,
      importedAt: importBatches.importedAt,
      importedByName: importer.fullName,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .leftJoin(chargeCodes, eq(timesheetEntries.chargeCodeId, chargeCodes.id))
    .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .leftJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
    .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
    .leftJoin(importBatches, eq(timesheetEntries.importBatchId, importBatches.id))
    .leftJoin(importer, eq(importBatches.importedBy, importer.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(timesheetEntries.createdAt))
    .limit(500);

  return rows.map((r) => {
    const kind = cellKind(r);
    return {
      id: r.id, userId: r.userId, userName: r.userName, userEmail: r.userEmail,
      cellCode: (r.chargeCodeId ?? r.indirectCodeId ?? r.clinId)!, kind, codeLabel: cellCodeLabel({ kind, ...r }),
      chargeCodeId: r.chargeCodeId, clinId: r.clinId, indirectCodeId: r.indirectCodeId,
      clinNumber: r.clinNumber, contractName: r.contractName, contractNumber: r.contractNumber, slinNumber: r.slinNumber,
      indirectCategory: r.indirectCategory ? indirectCategoryLabel(r.indirectCategory) : null,
      provenance: provenanceText(r),
      entryDate: r.entryDate as CalendarDate, hours: r.hours, revisionNumber: r.revisionNumber,
      changeReasonCode: r.changeReasonCode, comment: r.comment, createdAt: r.createdAt,
      createdById: r.createdById, createdByName: r.createdByName,
    };
  });
}

/**
 * The full revision history of one cell (user + true cell code + date), oldest first. C6: the cell is
 * COALESCE(charge_code_id, indirect_code_id, clin_id) = cellCode — sibling charge codes on one CLIN keep separate
 * histories, and indirect cells work like any other.
 */
export async function getCellRevisionHistory(
  userId: string,
  cellCode: string,
  entryDate: CalendarDate,
): Promise<CellRevisionHistory | null> {
  const actor = await requireApprover();
  await assertCanAccessEmployee(actor, userId);
  validateUUID(cellCode, 'Cell code');

  const db = await getDb();
  const day = parseCalendarDate(entryDate);

  const rows = await db
    .select({
      id: timesheetEntries.id,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
      changeReasonCode: timesheetEntries.changeReasonCode,
      comment: timesheetEntries.comment,
      createdAt: timesheetEntries.createdAt,
      createdByName: sql<string | null>`(SELECT full_name FROM users WHERE id = ${timesheetEntries.createdBy})`,
      chargeCodeId: timesheetEntries.chargeCodeId,
      indirectCodeId: timesheetEntries.indirectCodeId,
      chargeCode: chargeCodes.code,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      indirectCode: indirectChargeCodes.code,
      indirectCategory: indirectChargeCodes.category,
      source: timesheetEntries.source,
      originalMetadata: timesheetEntries.originalMetadata,
      importSourceSystem: importBatches.sourceSystem,
      importedAt: importBatches.importedAt,
      importedByName: importer.fullName,
    })
    .from(timesheetEntries)
    .leftJoin(chargeCodes, eq(timesheetEntries.chargeCodeId, chargeCodes.id))
    .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .leftJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
    .leftJoin(importBatches, eq(timesheetEntries.importBatchId, importBatches.id))
    .leftJoin(importer, eq(importBatches.importedBy, importer.id))
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        eq(sql<string>`COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})`, cellCode),
        eq(timesheetEntries.entryDate, day),
      )
    )
    .orderBy(timesheetEntries.revisionNumber);

  if (rows.length === 0) return null;

  const [userRow] = await db
    .select({ userName: users.fullName })
    .from(users)
    .where(eq(users.id, userId));

  if (!userRow) return null;

  const first = rows[0];
  const kind = cellKind(first);
  return {
    userId,
    userName: userRow.userName,
    cellCode,
    kind,
    codeLabel: cellCodeLabel({ kind, ...first }),
    clinNumber: kind === 'indirect' ? null : first.clinNumber,
    contractName: kind === 'indirect' ? null : first.contractName,
    indirectCategory: first.indirectCategory ? indirectCategoryLabel(first.indirectCategory) : null,
    entryDate: day,
    revisions: rows.map((r) => ({
      id: r.id, hours: r.hours, revisionNumber: r.revisionNumber, changeReasonCode: r.changeReasonCode, comment: r.comment,
      createdAt: r.createdAt, createdByName: r.createdByName, provenance: provenanceText(r),
    })),
  };
}

/**
 * Period events (submitted / approved / rejected) for the audit trail, scoped like the entries, filtered by employee
 * and by period start within the date range. Each is labelled by the one approval helper (C2: "Self-approved" with its
 * recorded context; imported events labelled with their source system).
 */
export async function getAuditPeriodEvents(filters: Pick<AuditFilters, 'userId' | 'startDate' | 'endDate'>): Promise<AuditPeriodEvent[]> {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  if (scope !== 'all' && scope.length === 0) return [];

  const db = await getDb();
  const rows = await db
    .select({
      id: periodEvents.id, periodId: periodEvents.periodId, userId: periodEvents.userId, userName: users.fullName,
      periodStart: timesheetPeriods.periodStart, event: periodEvents.event, actorId: periodEvents.actorId,
      comment: periodEvents.comment, createdAt: periodEvents.createdAt, source: periodEvents.source,
      originalMetadata: periodEvents.originalMetadata, approvalContext: periodEvents.approvalContext,
      importSourceSystem: importBatches.sourceSystem, importedAt: importBatches.importedAt,
    })
    .from(periodEvents)
    .innerJoin(users, eq(periodEvents.userId, users.id))
    .innerJoin(timesheetPeriods, eq(periodEvents.periodId, timesheetPeriods.id))
    .leftJoin(importBatches, eq(periodEvents.importBatchId, importBatches.id))
    .where(and(
      scope === 'all' ? undefined : inArray(periodEvents.userId, scope),
      filters.userId ? eq(periodEvents.userId, filters.userId) : undefined,
      filters.startDate ? gte(timesheetPeriods.periodStart, parseCalendarDate(filters.startDate)) : undefined,
      filters.endDate ? lte(timesheetPeriods.periodStart, parseCalendarDate(filters.endDate)) : undefined,
    ))
    .orderBy(desc(periodEvents.createdAt))
    .limit(500);

  // Names for actors and for whoever switched self-approval on (approval_context).
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.actorId) ids.add(r.actorId);
    const by = (r.approvalContext as { selfApprovalEnabledBy?: unknown } | null)?.selfApprovalEnabledBy;
    if (typeof by === 'string') ids.add(by);
  }
  const names = ids.size === 0 ? [] : await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, [...ids]));
  const nameById = new Map(names.map((n) => [n.id, n.fullName]));
  const timeZone = await getWorkspaceTimezone();

  return rows.map((r) => {
    const label = periodEventLabel(r, r.userId, (id) => nameById.get(id) ?? null, timeZone);
    return {
      id: r.id, userId: r.userId, userName: r.userName, periodStart: r.periodStart as CalendarDate, event: r.event,
      text: label.text, selfApproved: label.selfApproved, context: label.context, comment: r.comment, createdAt: r.createdAt,
    };
  });
}

/**
 * Get summary statistics for the audit trail, scoped to the approver's employees.
 */
export async function getAuditSummary(): Promise<{
  totalEntries: number;
  totalCorrections: number;
  totalLateEntries: number;
  uniqueUsers: number;
}> {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  if (scope !== 'all' && scope.length === 0) {
    return { totalEntries: 0, totalCorrections: 0, totalLateEntries: 0, uniqueUsers: 0 };
  }

  const db = await getDb();
  const whereClause = scope === 'all' ? undefined : inArray(timesheetEntries.userId, scope);

  // Single query with FILTER clauses — replaces 4 sequential COUNT queries
  const [result] = await db
    .select({
      totalEntries: sql<number>`COUNT(*)`,
      totalCorrections: sql<number>`COUNT(*) FILTER (WHERE ${timesheetEntries.changeReasonCode} = 'CORRECTION')`,
      totalLateEntries: sql<number>`COUNT(*) FILTER (WHERE ${timesheetEntries.changeReasonCode} = 'LATE_ENTRY')`,
      uniqueUsers: sql<number>`COUNT(DISTINCT ${timesheetEntries.userId})`,
    })
    .from(timesheetEntries)
    .where(whereClause);

  return {
    totalEntries: result.totalEntries,
    totalCorrections: result.totalCorrections,
    totalLateEntries: result.totalLateEntries,
    uniqueUsers: result.uniqueUsers,
  };
}

/**
 * Get contracts for the filter dropdown. Admins see every contract; supervisors see only
 * contracts touched by a CLIN they themselves are assigned to (the same basis their scope
 * is derived from).
 */
export async function getContractsForFilter() {
  const actor = await requireApprover();
  const db = await getDb();

  if (actor.role === 'admin') {
    return db
      .select({ id: contracts.id, name: contracts.name, contractNumber: contracts.contractNumber })
      .from(contracts)
      .orderBy(contracts.name);
  }

  const rows = await db
    .selectDistinct({ id: contracts.id, name: contracts.name, contractNumber: contracts.contractNumber })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(and(eq(userAssignments.userId, actor.id), eq(userAssignments.isActive, true)))
    .orderBy(contracts.name);

  return rows;
}

/**
 * Get all CLINs for a specific contract (for filter dropdown cascade). Admins see every CLIN
 * under the contract; supervisors see only the ones they themselves are assigned to.
 */
export async function getClinsForFilter(contractId: string) {
  const actor = await requireApprover();
  const db = await getDb();

  if (actor.role === 'admin') {
    return db
      .select({ id: clins.id, clinNumber: clins.clinNumber, description: clins.description })
      .from(clins)
      .where(eq(clins.contractId, contractId))
      .orderBy(clins.clinNumber);
  }

  const rows = await db
    .selectDistinct({ id: clins.id, clinNumber: clins.clinNumber, description: clins.description })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .where(
      and(
        eq(userAssignments.userId, actor.id),
        eq(userAssignments.isActive, true),
        eq(clins.contractId, contractId),
      )
    )
    .orderBy(clins.clinNumber);

  return rows;
}

/**
 * Get users for the filter dropdown, scoped to the approver's employees.
 */
export async function getUsersForFilter() {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  const db = await getDb();

  if (scope === 'all') {
    return db
      .select({ id: users.id, fullName: users.fullName, email: users.email })
      .from(users)
      .orderBy(users.fullName);
  }

  if (scope.length === 0) return [];

  return db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(inArray(users.id, scope))
    .orderBy(users.fullName);
}
