'use server';

import { getDb } from '@/db';
import {
  timesheetEntries, users, clins, contracts, slins, chargeCodes, indirectChargeCodes, importBatches,
  periodEvents, timesheetPeriods, adminChangeLog, laborCategories,
} from '@/db/schema';
import { eq, and, gte, lte, desc, sql, inArray } from 'drizzle-orm';
import { ownFilterClinIds } from '@/server/internal/supervisor-scope';
import { alias } from 'drizzle-orm/pg-core';
import { requireAdmin, requireApprover, getEmployeeScope, assertCanAccessEmployee } from '@/lib/session';
import { addDays, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { AUDIT_LATE_ROW, auditEntryWhere, validAuditFilters, type AuditEntryFilters } from '@/server/internal/audit-export';
import { describeAdminChange, type AdminChangeNames } from '@/lib/audit/admin-change-format';
import { existingPeriodLength } from '@/server/internal/pay-period-config';
import { cellCodeLabel, cellKind, type CellKind } from '@/lib/cell-code';
import { indirectCategoryLabel } from '@/lib/indirect-categories';
import { provenanceText } from '@/lib/provenance';
import { validateCalendarDate, validateOptionalCalendarDate, validateUUID } from '@/lib/validation';
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
  /** 'app' or an import source (R3: a late row is an app-recorded revision 1 with a reason). */
  source: string;
}

/** The entry filters (feature-plan-ux-people-codes.md §6.2); `revisionsOnly` = "Changed entries only" (revision ≥ 2). */
export type AuditFilters = AuditEntryFilters;

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
  /** The period's last day (its stored length, else the schedule's), for "Oct 1 – 15, 2026". */
  periodEnd: CalendarDate;
  event: 'submitted' | 'approved' | 'rejected';
  text: string;
  selfApproved: boolean;
  /** §6.3: who acted, and whether it was the employee themselves (a self-approval or self-return). */
  actorId: string | null;
  actorName: string | null;
  self: boolean;
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
/** §6.2: the entries list pages 50 at a time, with a total. */
const AUDIT_PAGE_SIZE = 50;
/** Period events shown per search; one more is fetched so a capped result says so (fix round 1, F12). */
const EVENT_ROW_LIMIT = 500;
/** Candidate period events read for a date-filtered search before the exact overlap check (R3). */
const EVENT_CANDIDATE_LIMIT = 5000;

export async function getAuditEntries(filters: AuditFilters & { page?: number }): Promise<{ entries: AuditEntry[]; total: number; page: number; pageSize: number }> {
  const actor = await requireApprover();
  // F12: every id / date input validated after the guard.
  const f = validAuditFilters(filters);
  const page = Number.isInteger(filters?.page) && (filters.page as number) >= 1 ? (filters.page as number) : 1;
  const scope = await getEmployeeScope(actor);
  if (scope !== 'all' && scope.length === 0) return { entries: [], total: 0, page, pageSize: AUDIT_PAGE_SIZE };

  const db = await getDb();
  // §6.2: the ONE filter builder (shared with the count, the summary and the CSV).
  const where = auditEntryWhere(db, scope, f);
  const [{ total }] = await db.select({ total: sql<number>`COUNT(*)`.mapWith(Number) }).from(timesheetEntries).where(where);

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
    .where(where)
    // F12: a stable order — rows written in one transaction share created_at.
    .orderBy(desc(timesheetEntries.createdAt), desc(timesheetEntries.id))
    .limit(AUDIT_PAGE_SIZE)
    .offset((page - 1) * AUDIT_PAGE_SIZE);

  const entries = rows.map((r) => {
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
      source: r.source,
    };
  });
  return { entries, total, page, pageSize: AUDIT_PAGE_SIZE };
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
  validateUUID(userId, 'Employee');
  validateUUID(cellCode, 'Cell code');
  await assertCanAccessEmployee(actor, userId);

  const db = await getDb();
  const day = validateCalendarDate(entryDate, 'Entry date');

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
export async function getAuditPeriodEvents(filters: Pick<AuditFilters, 'userId' | 'startDate' | 'endDate'>): Promise<{ events: AuditPeriodEvent[]; truncated: boolean }> {
  const actor = await requireApprover();
  if (filters.userId) validateUUID(filters.userId, 'Employee');
  const startDate = validateOptionalCalendarDate(filters.startDate, 'Start date');
  const endDate = validateOptionalCalendarDate(filters.endDate, 'End date');
  const scope = await getEmployeeScope(actor);
  if (scope !== 'all' && scope.length === 0) return { events: [], truncated: false };

  const db = await getDb();
  const candidates = await db
    .select({
      id: periodEvents.id, periodId: periodEvents.periodId, userId: periodEvents.userId, userName: users.fullName,
      periodStart: timesheetPeriods.periodStart, periodNumDays: timesheetPeriods.periodNumDays, event: periodEvents.event, actorId: periodEvents.actorId,
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
      // F12: the period OVERLAPS the range. No period is longer than 31 days, so a period that ends on/after the start
      // began at most 31 days before it; the exact end is checked below with the period's real length.
      startDate ? gte(timesheetPeriods.periodStart, addDays(startDate, -31)) : undefined,
      endDate ? lte(timesheetPeriods.periodStart, endDate) : undefined,
    ))
    .orderBy(desc(periodEvents.createdAt), desc(periodEvents.id))
    .limit(startDate ? EVENT_CANDIDATE_LIMIT : EVENT_ROW_LIMIT + 1);

  const lengths = new Map<string, number>();
  const lengthOf = async (start: CalendarDate, numDays: number | null) => {
    const key = `${start}|${numDays ?? ''}`;
    if (!lengths.has(key)) lengths.set(key, await existingPeriodLength(db, start, numDays));
    return lengths.get(key)!;
  };
  const overlapping = [];
  for (const r of candidates) {
    if (startDate) {
      const start = r.periodStart as CalendarDate;
      if (isBefore(addDays(start, (await lengthOf(start, r.periodNumDays)) - 1), startDate)) continue; // ended before the range
    }
    overlapping.push(r);
  }
  // R3: also truncated when the candidate prefetch itself hit its cap (more events may exist beyond it).
  const truncated = overlapping.length > EVENT_ROW_LIMIT || candidates.length === EVENT_CANDIDATE_LIMIT;
  const rows = overlapping.slice(0, EVENT_ROW_LIMIT);

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

  const ends = new Map<string, CalendarDate>();
  for (const r of rows) {
    const start = r.periodStart as CalendarDate;
    ends.set(r.id, addDays(start, (await lengthOf(start, r.periodNumDays)) - 1));
  }
  const events = rows.map((r) => {
    const label = periodEventLabel(r, r.userId, (id) => nameById.get(id) ?? null, timeZone);
    return {
      id: r.id, userId: r.userId, userName: r.userName, periodStart: r.periodStart as CalendarDate, periodEnd: ends.get(r.id)!, event: r.event,
      text: label.text, selfApproved: label.selfApproved, context: label.context, comment: r.comment, createdAt: r.createdAt,
      actorId: r.actorId, actorName: r.actorId ? nameById.get(r.actorId) ?? null : null, self: r.actorId !== null && r.actorId === r.userId,
    };
  });
  return { events, truncated };
}

/**
 * The strip above the entries (feature-plan-ux-people-codes.md §6.2), for the SAME scope and filters as the list:
 * entries, changed (revision ≥ 2), late (R3: an app-recorded revision 1 with a reason — rows, so it can differ from
 * Approvals, which counts a cell late only if it was never corrected) and distinct people. COUNTs map to numbers.
 */
export async function getAuditSummary(filters: AuditFilters = {}): Promise<{ entries: number; changed: number; late: number; people: number }> {
  const actor = await requireApprover();
  const f = validAuditFilters(filters);
  const scope = await getEmployeeScope(actor);
  if (scope !== 'all' && scope.length === 0) return { entries: 0, changed: 0, late: 0, people: 0 };

  const db = await getDb();
  const [result] = await db
    .select({
      entries: sql<number>`COUNT(*)`.mapWith(Number),
      changed: sql<number>`COUNT(*) FILTER (WHERE ${timesheetEntries.revisionNumber} >= 2)`.mapWith(Number),
      late: sql<number>`COUNT(*) FILTER (WHERE ${AUDIT_LATE_ROW})`.mapWith(Number),
      people: sql<number>`COUNT(DISTINCT ${timesheetEntries.userId})`.mapWith(Number),
    })
    .from(timesheetEntries)
    .where(auditEntryWhere(db, scope, f));
  return { entries: result?.entries ?? 0, changed: result?.changed ?? 0, late: result?.late ?? 0, people: result?.people ?? 0 };
}

// ── Admin changes (§6.4, admins only) ─────────────────────────────────────────────────────────────────────────────

export interface AdminChangeEntry { id: string; createdAt: Date; change: string; details: string; byName: string | null }
const ADMIN_CHANGE_PAGE_SIZE = 50;

/**
 * The admin change log for a date range in the WORKSPACE's days ((created_at AT TIME ZONE tz)::date), newest first, 50
 * a page with a total; names for the subject AND for ids inside the values are resolved in batches per kind, and each
 * row is worded by describeAdminChange (an unknown pair never throws).
 */
export async function getAdminChanges(input: { start: CalendarDate; end: CalendarDate; page?: number }): Promise<{ rows: AdminChangeEntry[]; total: number; page: number; pageSize: number }> {
  await requireAdmin();
  const start = validateCalendarDate(input?.start, 'Start date');
  const end = validateCalendarDate(input?.end, 'End date');
  const page = Number.isInteger(input?.page) && (input.page as number) >= 1 ? (input.page as number) : 1;
  const db = await getDb();
  const tz = await getWorkspaceTimezone();
  const inRange = sql`(${adminChangeLog.createdAt} AT TIME ZONE ${tz})::date BETWEEN ${start}::date AND ${end}::date`;
  const [{ total }] = await db.select({ total: sql<number>`COUNT(*)`.mapWith(Number) }).from(adminChangeLog).where(inRange);
  const actor = alias(users, 'change_actor');
  const rows = await db
    .select({
      id: adminChangeLog.id, createdAt: adminChangeLog.createdAt, entity: adminChangeLog.entity, action: adminChangeLog.action,
      entityId: adminChangeLog.entityId, oldValue: adminChangeLog.oldValue, newValue: adminChangeLog.newValue, byName: actor.fullName,
    })
    .from(adminChangeLog)
    .leftJoin(actor, eq(adminChangeLog.actorId, actor.id))
    .where(inRange)
    .orderBy(desc(adminChangeLog.createdAt), desc(adminChangeLog.id))
    .limit(ADMIN_CHANGE_PAGE_SIZE)
    .offset((page - 1) * ADMIN_CHANGE_PAGE_SIZE);
  const names = await adminChangeNames(db, rows);
  return {
    rows: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, byName: r.byName, ...describeAdminChange(r, names) })),
    total, page, pageSize: ADMIN_CHANGE_PAGE_SIZE,
  };
}

/** Batch-resolves every id a page of rows mentions: users, charge codes, labor categories and CLINs. Missing → absent ("(deleted)"). */
async function adminChangeNames(db: Awaited<ReturnType<typeof getDb>>, rows: Array<{ entity: string; entityId: string; oldValue: unknown; newValue: unknown }>): Promise<AdminChangeNames> {
  const userIds = new Set<string>(), codeIds = new Set<string>(), lcIds = new Set<string>(), clinIds = new Set<string>();
  const val = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const add = (set: Set<string>, id: unknown) => { if (typeof id === 'string' && UUID_RE.test(id)) set.add(id); };
  for (const r of rows) {
    if (r.entity === 'user' || r.entity === 'self_approval') add(userIds, r.entityId);
    if (r.entity === 'charge_code' || r.entity === 'charge_code_labor_category') add(codeIds, r.entityId);
    if (r.entity === 'labor_category_rate') add(lcIds, r.entityId);
    for (const v of [val(r.oldValue), val(r.newValue)]) {
      add(userIds, v.approverId);
      add(lcIds, v.laborCategoryId);
      if (Array.isArray(v.clinIds)) for (const id of v.clinIds) add(clinIds, id);
      // feature-plan-approval-scope.md §4.2: approval_scope rows and a demotion's membershipRemoved.
      add(userIds, v.supervisorId);
      add(clinIds, v.clinId);
      if (Array.isArray(v.membershipRemoved)) for (const id of v.membershipRemoved) add(clinIds, id);
    }
  }
  const names: AdminChangeNames = {};
  const [u, c, l, k] = await Promise.all([
    userIds.size ? db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, [...userIds])) : Promise.resolve([]),
    codeIds.size ? db.select({ id: chargeCodes.id, name: chargeCodes.code }).from(chargeCodes).where(inArray(chargeCodes.id, [...codeIds])) : Promise.resolve([]),
    lcIds.size ? db.select({ id: laborCategories.id, code: laborCategories.lcatCode, title: laborCategories.title }).from(laborCategories).where(inArray(laborCategories.id, [...lcIds])) : Promise.resolve([]),
    clinIds.size ? db.select({ id: clins.id, clinNumber: clins.clinNumber, contractName: contracts.name }).from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id)).where(inArray(clins.id, [...clinIds])) : Promise.resolve([]),
  ]);
  for (const r of u) names[r.id] = r.name;
  for (const r of c) names[r.id] = r.name;
  for (const r of l) names[r.id] = `${r.code} ${r.title}`;
  for (const r of k) names[r.id] = `${r.contractName} CLIN ${r.clinNumber}`;
  return names;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get contracts for the filter dropdown. Admins see every contract; supervisors see the contracts
 * of the CLINs they approve or charge (feature-plan-approval-scope.md S4).
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

  // feature-plan-approval-scope.md S4: the contracts of the CLINs they approve or charge.
  const own = await ownFilterClinIds(db, actor.id);
  if (own.length === 0) return [];
  return db
    .selectDistinct({ id: contracts.id, name: contracts.name, contractNumber: contracts.contractNumber })
    .from(clins)
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(inArray(clins.id, own))
    .orderBy(contracts.name);
}

/**
 * Get all CLINs for a specific contract (for filter dropdown cascade). Admins see every CLIN
 * under the contract; supervisors see the ones they approve or charge (S4).
 */
export async function getClinsForFilter(contractId: string) {
  const actor = await requireApprover();
  validateUUID(contractId, 'Contract');
  const db = await getDb();

  if (actor.role === 'admin') {
    return db
      .select({ id: clins.id, clinNumber: clins.clinNumber, description: clins.description })
      .from(clins)
      .where(eq(clins.contractId, contractId))
      .orderBy(clins.clinNumber);
  }

  // feature-plan-approval-scope.md S4: the CLINs they approve or charge, under this contract.
  const own = await ownFilterClinIds(db, actor.id);
  if (own.length === 0) return [];
  return db
    .selectDistinct({ id: clins.id, clinNumber: clins.clinNumber, description: clins.description })
    .from(clins)
    .where(and(inArray(clins.id, own), eq(clins.contractId, contractId)))
    .orderBy(clins.clinNumber);
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
