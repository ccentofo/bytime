'use server';

import { getDb } from '@/db';
import {
  users,
  contracts,
  clins,
  slins,
  timesheetEntries,
  timesheetPeriods,
  laborCategories,
  userLaborCategories,
  userAssignments,
} from '@/db/schema';
import { eq, and, gte, lt, desc, sql, inArray } from 'drizzle-orm';
import { calendarDayWindow } from '@/server/internal/periods';
import dayjs from 'dayjs';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import { requireSession, requireAdmin, requireApprover, getEmployeeScope, assertCanAccessEmployee } from '@/lib/session';
import { getDetailedCostReportData, type CostReportEntry } from '@/server/internal/reports';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimesheetReportData {
  employee: {
    id: string;
    fullName: string;
    email: string;
  };
  periodStart: Date;
  periodEnd: Date;
  periodStatus: string;
  submittedAt: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  chargeCodes: Array<{
    clinNumber: string;
    contractName: string;
    contractNumber: string;
    slinNumber: string | null;
    description: string;
    dailyHours: number[]; // one per day in the period
    totalHours: number;
  }>;
  dailyTotals: number[]; // sum of all charge codes per day
  grandTotal: number;
}

export interface EmployeeSummaryEntry {
  employeeName: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  totalHours: number;
  totalCost?: number; // R2-5: omitted entirely (not 0) for non-admins — dollar data is admin-only
  flsaExempt: boolean;
}

// ---------------------------------------------------------------------------
// Individual Timesheet Report
// ---------------------------------------------------------------------------

/**
 * Get complete timesheet data for a specific user and period.
 * Used to generate the PDF timesheet report.
 */
export async function getTimesheetReportData(
  userId: string,
  periodStart: Date
): Promise<TimesheetReportData | null> {
  const actor = await requireSession();
  await assertCanAccessEmployee(actor, userId);
  const db = await getDb();
  // Get user info
  const [user] = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) return null;

  // Get period info
  const numDays = getNumDaysInPeriod(periodStart);
  const periodEnd = dayjs(periodStart).add(numDays - 1, 'day').toDate();

  const [dayFrom, dayTo] = calendarDayWindow(periodStart);
  const periodRows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        gte(timesheetPeriods.periodStart, dayFrom),
        lt(timesheetPeriods.periodStart, dayTo),
      )
    );

  const period = periodRows[0];

  // Get approved-by name if applicable. R2-7: an admin may approve/reject their own period —
  // show "Self-approved" rather than their own name, so self-approval stays visibly auditable.
  // Only an APPROVED period prints an approval line; rejecting also sets reviewedBy/reviewedAt,
  // and a rejected timesheet must never read as approved.
  const isApproved = period?.status === 'approved';
  let approvedByName: string | null = null;
  if (isApproved && period?.reviewedBy) {
    if (period.reviewedBy === userId) {
      approvedByName = 'Self-approved';
    } else {
      const [reviewer] = await db
        .select({ fullName: users.fullName })
        .from(users)
        .where(eq(users.id, period.reviewedBy));
      approvedByName = reviewer?.fullName ?? null;
    }
  }

  // Get user's charge codes
  const assignments = await db
    .select({
      clinId: clins.id,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      description: clins.description,
      slinId: userAssignments.slinId,
      slinNumber: slins.slinNumber,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(userAssignments.slinId, slins.id))
    .where(
      and(
        eq(userAssignments.userId, userId),
        eq(userAssignments.isActive, true),
      )
    )
    .orderBy(contracts.name, clins.clinNumber);

  // Get all entries for this period (latest revision only)
  const entries = await db
    .select({
      clinId: timesheetEntries.clinId,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, periodStart),
        lt(timesheetEntries.entryDate, dayjs(periodStart).add(numDays, 'day').toDate()),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND te2.clin_id = ${timesheetEntries.clinId}
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
      )
    );

  // Build hours map: "clinId-dayIndex" → hours
  const hoursMap = new Map<string, number>();
  for (const entry of entries) {
    const dayIndex = dayjs(entry.entryDate).diff(dayjs(periodStart), 'day');
    hoursMap.set(`${entry.clinId}-${dayIndex}`, parseFloat(entry.hours) || 0);
  }

  // Build charge code data
  const chargeCodes = assignments.map((a) => {
    const dailyHours: number[] = [];
    let totalHours = 0;
    for (let i = 0; i < numDays; i++) {
      const h = hoursMap.get(`${a.clinId}-${i}`) ?? 0;
      dailyHours.push(h);
      totalHours += h;
    }
    return {
      clinNumber: a.clinNumber,
      contractName: a.contractName,
      contractNumber: a.contractNumber,
      slinNumber: a.slinNumber,
      description: a.description ?? '',
      dailyHours,
      totalHours: Math.round(totalHours * 100) / 100,
    };
  });

  // Daily totals
  const dailyTotals: number[] = [];
  for (let i = 0; i < numDays; i++) {
    let dayTotal = 0;
    for (const cc of chargeCodes) {
      dayTotal += cc.dailyHours[i];
    }
    dailyTotals.push(Math.round(dayTotal * 100) / 100);
  }

  const grandTotal = chargeCodes.reduce((sum, cc) => sum + cc.totalHours, 0);

  return {
    employee: user,
    periodStart,
    periodEnd,
    periodStatus: period?.status ?? 'draft',
    submittedAt: period?.submittedAt ?? null,
    approvedAt: isApproved ? period?.reviewedAt ?? null : null,
    approvedBy: approvedByName,
    chargeCodes,
    dailyTotals,
    grandTotal: Math.round(grandTotal * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Cost Report (Detailed)
// ---------------------------------------------------------------------------

/**
 * Get detailed cost report for a date range.
 * Each row = one employee + one CLIN + one day with hours and cost.
 */
export async function getDetailedCostReport(
  startDate: Date,
  endDate: Date,
  contractId?: string
): Promise<CostReportEntry[]> {
  await requireAdmin();
  return getDetailedCostReportData(startDate, endDate, contractId);
}

// ---------------------------------------------------------------------------
// Employee Summary Report
// ---------------------------------------------------------------------------

/**
 * Get aggregated hours/cost summary per employee per contract/CLIN.
 * Approver-scoped: a supervisor sees only in-scope employees, and never dollar figures —
 * labor rates are admin-only (see the access model). Admins get hours and cost, unrestricted.
 */
export async function getEmployeeSummaryReport(
  startDate: Date,
  endDate: Date
): Promise<EmployeeSummaryEntry[]> {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  if (scope !== 'all' && scope.length === 0) return [];

  const db = await getDb();
  const endDateExclusive = dayjs(endDate).add(1, 'day').toDate();

  const rows = await db
    .select({
      employeeName: users.fullName,
      flsaExempt: users.flsaExempt,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      totalCost: sql<number>`COALESCE(SUM(
        CAST(${timesheetEntries.hours} AS NUMERIC) *
        COALESCE(CAST(${laborCategories.hourlyRate} AS NUMERIC), 0)
      ), 0)`,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(
      userLaborCategories,
      and(
        eq(userLaborCategories.userId, timesheetEntries.userId),
        sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
        sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
      )
    )
    .leftJoin(
      laborCategories,
      and(
        eq(laborCategories.id, userLaborCategories.laborCategoryId),
        eq(laborCategories.clinId, timesheetEntries.clinId),
        eq(laborCategories.status, 'active'),
      )
    )
    .where(
      and(
        gte(timesheetEntries.entryDate, startDate),
        lt(timesheetEntries.entryDate, endDateExclusive),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND te2.clin_id = ${timesheetEntries.clinId}
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
        scope === 'all' ? undefined : inArray(timesheetEntries.userId, scope),
      )
    )
    .groupBy(users.fullName, users.flsaExempt, contracts.name, contracts.contractNumber, clins.clinNumber)
    .orderBy(users.fullName, contracts.name, clins.clinNumber);

  const isAdmin = actor.role === 'admin';
  return rows.map((row) => ({
    employeeName: row.employeeName,
    contractName: row.contractName,
    contractNumber: row.contractNumber,
    clinNumber: row.clinNumber,
    totalHours: Math.round(Number(row.totalHours) * 100) / 100,
    // R2-5: the totalCost KEY is absent entirely for supervisors — dollar figures are
    // admin-only — not present-but-zero, which previously rendered a fake "$0" column.
    ...(isAdmin ? { totalCost: Math.round(Number(row.totalCost) * 100) / 100 } : {}),
    flsaExempt: row.flsaExempt,
  }));
}

// ---------------------------------------------------------------------------
// Available Users & Contracts for Report Filters
// ---------------------------------------------------------------------------

/**
 * Filter dropdown options for reports, scoped to the approver's employees. Admins get every
 * active user and every contract; supervisors get only in-scope employees and the contracts
 * touched by a CLIN they themselves are assigned to.
 */
export async function getReportFilterOptions() {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  const db = await getDb();

  const allUsers = scope === 'all'
    ? await db
        .select({ id: users.id, fullName: users.fullName, email: users.email })
        .from(users)
        .where(eq(users.isActive, true))
        .orderBy(users.fullName)
    : scope.length === 0
      ? []
      : await db
          .select({ id: users.id, fullName: users.fullName, email: users.email })
          .from(users)
          .where(and(eq(users.isActive, true), inArray(users.id, scope)))
          .orderBy(users.fullName);

  const allContracts = scope === 'all'
    ? await db
        .select({ id: contracts.id, name: contracts.name, contractNumber: contracts.contractNumber })
        .from(contracts)
        .orderBy(contracts.name)
    : await db
        .selectDistinct({ id: contracts.id, name: contracts.name, contractNumber: contracts.contractNumber })
        .from(userAssignments)
        .innerJoin(clins, eq(userAssignments.clinId, clins.id))
        .innerJoin(contracts, eq(clins.contractId, contracts.id))
        .where(and(eq(userAssignments.userId, actor.id), eq(userAssignments.isActive, true)))
        .orderBy(contracts.name);

  return { users: allUsers, contracts: allContracts };
}
