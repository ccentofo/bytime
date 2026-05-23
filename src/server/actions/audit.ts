'use server';

import { db } from '@/db';
import { timesheetEntries, users, clins, contracts, slins } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  clinId: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
  slinNumber: string | null;
  entryDate: Date;
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
  startDate?: Date;
  endDate?: Date;
  reasonCode?: string;
  revisionsOnly?: boolean; // if true, only show entries where revision_number > 1
}

export interface CellRevisionHistory {
  userId: string;
  userName: string;
  clinId: string;
  clinNumber: string;
  contractName: string;
  entryDate: Date;
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
// Audit Queries
// ---------------------------------------------------------------------------

/**
 * Get audit entries with filters. Returns all timesheet entries matching
 * the provided filter criteria, ordered by most recent first.
 * Limits to 500 rows to prevent overwhelming the UI.
 */
export async function getAuditEntries(filters: AuditFilters): Promise<AuditEntry[]> {
  // We need to alias the 'users' table for the createdBy join
  // Drizzle doesn't support table aliases easily, so we'll do two queries
  // or use a raw subselect. For simplicity, we'll join to users for the
  // entry owner and do a subquery for createdBy name.

  const conditions = [];

  if (filters.userId) {
    conditions.push(eq(timesheetEntries.userId, filters.userId));
  }
  if (filters.clinId) {
    conditions.push(eq(timesheetEntries.clinId, filters.clinId));
  }
  if (filters.startDate) {
    conditions.push(gte(timesheetEntries.entryDate, filters.startDate));
  }
  if (filters.endDate) {
    // endDate is inclusive, so add 1 day for lt comparison
    conditions.push(lt(timesheetEntries.entryDate, dayjs(filters.endDate).add(1, 'day').toDate()));
  }
  if (filters.reasonCode) {
    conditions.push(eq(timesheetEntries.changeReasonCode, filters.reasonCode));
  }
  if (filters.revisionsOnly) {
    conditions.push(gte(timesheetEntries.revisionNumber, 2));
  }

  // Build the where clause
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // If contractId filter is set, we need to filter by CLIN's contract
  // We'll handle this in the join condition

  let query = db
    .select({
      id: timesheetEntries.id,
      userId: timesheetEntries.userId,
      userName: users.fullName,
      userEmail: users.email,
      clinId: timesheetEntries.clinId,
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
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id));

  // Add contract filter if provided
  if (filters.contractId) {
    conditions.push(eq(contracts.id, filters.contractId));
  }

  const finalWhere = conditions.length > 0 ? and(...conditions) : undefined;

  // suppress unused variable warning
  void whereClause;

  const rows = await query
    .where(finalWhere)
    .orderBy(desc(timesheetEntries.createdAt))
    .limit(500);

  return rows;
}

/**
 * Get the full revision history for a specific cell (user + CLIN + date).
 * Returns all revisions ordered from oldest to newest.
 */
export async function getCellRevisionHistory(
  userId: string,
  clinId: string,
  entryDate: Date
): Promise<CellRevisionHistory | null> {
  const entryStart = dayjs(entryDate).startOf('day').toDate();
  const entryEnd = dayjs(entryDate).add(1, 'day').startOf('day').toDate();

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
        eq(timesheetEntries.clinId, clinId),
        gte(timesheetEntries.entryDate, entryStart),
        lt(timesheetEntries.entryDate, entryEnd),
      )
    )
    .orderBy(timesheetEntries.revisionNumber);

  if (rows.length === 0) return null;

  // Get user and CLIN context
  const context = await db
    .select({
      userName: users.fullName,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
    })
    .from(users)
    .innerJoin(clins, eq(clins.id, clinId))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (context.length === 0) return null;

  return {
    userId,
    userName: context[0].userName,
    clinId,
    clinNumber: context[0].clinNumber,
    contractName: context[0].contractName,
    entryDate: entryStart,
    revisions: rows,
  };
}

/**
 * Get summary statistics for the audit trail.
 * Returns counts of total entries, corrections, late entries, etc.
 */
export async function getAuditSummary(): Promise<{
  totalEntries: number;
  totalCorrections: number;
  totalLateEntries: number;
  uniqueUsers: number;
}> {
  const [totalResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries);

  const [correctionsResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries)
    .where(eq(timesheetEntries.changeReasonCode, 'CORRECTION'));

  const [lateResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries)
    .where(eq(timesheetEntries.changeReasonCode, 'LATE_ENTRY'));

  const [usersResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${timesheetEntries.userId})` })
    .from(timesheetEntries);

  return {
    totalEntries: totalResult.count,
    totalCorrections: correctionsResult.count,
    totalLateEntries: lateResult.count,
    uniqueUsers: usersResult.count,
  };
}

/**
 * Get all contracts (for filter dropdown).
 * Re-exported here to avoid importing from contracts.ts in the client.
 */
export async function getContractsForFilter() {
  return db
    .select({
      id: contracts.id,
      name: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(contracts)
    .orderBy(contracts.name);
}

/**
 * Get all CLINs for a specific contract (for filter dropdown cascade).
 */
export async function getClinsForFilter(contractId: string) {
  return db
    .select({
      id: clins.id,
      clinNumber: clins.clinNumber,
      description: clins.description,
    })
    .from(clins)
    .where(eq(clins.contractId, contractId))
    .orderBy(clins.clinNumber);
}

/**
 * Get all users (for filter dropdown).
 * Re-exported here to keep the audit page self-contained.
 */
export async function getUsersForFilter() {
  return db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
    })
    .from(users)
    .orderBy(users.fullName);
}
