'use server';

import { getDb } from '@/db';
import { timesheetEntries, users, clins, contracts, slins, userAssignments } from '@/db/schema';
import { eq, and, gte, lt, desc, sql, inArray } from 'drizzle-orm';
import { requireApprover, getEmployeeScope, assertCanAccessEmployee } from '@/lib/session';
import { addDays, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  clinId: string | null;
  indirectCodeId: string | null;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
  slinNumber: string | null;
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
  clinId: string | null;
  clinNumber: string;
  contractName: string;
  indirectCodeId?: string | null;
  indirectCode?: string | null;
  entryDate: CalendarDate;
  revisions: Array<{
    id: string;
    hours: string;
    revisionNumber: number;
    changeReasonCode: string | null;
    comment: string | null;
    createdAt: Date;
    createdByName: string | null;
  }>;
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

  const rows = await db
    .select({
      id: timesheetEntries.id,
      userId: timesheetEntries.userId,
      userName: users.fullName,
      userEmail: users.email,
      clinId: timesheetEntries.clinId,
      indirectCodeId: timesheetEntries.indirectCodeId,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
      changeReasonCode: timesheetEntries.changeReasonCode,
      comment: timesheetEntries.comment,
      createdAt: timesheetEntries.createdAt,
      createdById: timesheetEntries.createdBy,
      createdByName: sql<string | null>`(SELECT full_name FROM users WHERE id = ${timesheetEntries.createdBy})`,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(timesheetEntries.createdAt))
    .limit(500);

  return rows as AuditEntry[];
}

/**
 * Get the full revision history for a specific cell (user + CLIN + date).
 * Returns all revisions ordered from oldest to newest.
 */
export async function getCellRevisionHistory(
  userId: string,
  clinId: string | null,
  entryDate: CalendarDate,
  indirectCodeId?: string | null
): Promise<CellRevisionHistory | null> {
  const actor = await requireApprover();
  await assertCanAccessEmployee(actor, userId);

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
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        clinId
          ? eq(timesheetEntries.clinId, clinId)
          : eq(timesheetEntries.indirectCodeId, indirectCodeId!),
        eq(timesheetEntries.entryDate, day),
      )
    )
    .orderBy(timesheetEntries.revisionNumber);

  if (rows.length === 0) return null;

  // Get user context
  const [userRow] = await db
    .select({ userName: users.fullName })
    .from(users)
    .where(eq(users.id, userId));

  if (!userRow) return null;

  let clinNumber = '—';
  let contractName = '—';
  let indirectCode: string | null = null;

  if (clinId) {
    // Direct entry — get CLIN/contract context
    const clinContext = await db
      .select({
        clinNumber: clins.clinNumber,
        contractName: contracts.name,
      })
      .from(clins)
      .innerJoin(contracts, eq(clins.contractId, contracts.id))
      .where(eq(clins.id, clinId))
      .limit(1);

    if (clinContext.length > 0) {
      clinNumber = clinContext[0].clinNumber;
      contractName = clinContext[0].contractName;
    }
  } else if (indirectCodeId) {
    // Indirect entry — get indirect code context
    const { indirectChargeCodes } = await import('@/db/schema');
    const indirectContext = await db
      .select({
        code: indirectChargeCodes.code,
        name: indirectChargeCodes.name,
      })
      .from(indirectChargeCodes)
      .where(eq(indirectChargeCodes.id, indirectCodeId))
      .limit(1);

    if (indirectContext.length > 0) {
      clinNumber = indirectContext[0].code;
      contractName = indirectContext[0].name;
      indirectCode = indirectContext[0].code;
    }
  }

  return {
    userId,
    userName: userRow.userName,
    clinId,
    clinNumber,
    contractName,
    indirectCodeId: indirectCodeId ?? null,
    indirectCode,
    entryDate: day,
    revisions: rows,
  };
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
