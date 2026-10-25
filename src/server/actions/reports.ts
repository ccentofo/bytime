'use server';

import { getDb } from '@/db';
import {
  users,
  contracts,
  clins,
  slins,
  timesheetEntries,
  timesheetPeriods,
  userAssignments,
} from '@/db/schema';
import { eq, and, gte, lt, sql, inArray } from 'drizzle-orm';
import { existingPeriodLength } from '@/server/internal/pay-period-config';
import { approvalLabels } from '@/server/internal/approval-label';
import { COST_BASIS_LATERAL, COST_LC_ON, costLaborCategory, pricedCostSum, unpricedHoursSum } from '@/server/internal/cost-basis';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { requireSession, requireAdmin, requireApprover, getEmployeeScope, assertCanAccessEmployee } from '@/lib/session';
import { getDetailedCostReportData, type CostReportEntry } from '@/server/internal/reports';
import { addDays, diffDays, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimesheetReportData {
  employee: {
    id: string;
    fullName: string;
    email: string;
  };
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  periodStatus: string;
  submittedAt: Date | null;
  approvedAt: Date | null;
  /** The approver field: the in-app approver's name, the "Self-approved" badge, or the imported line (approvalLabel). */
  approvedBy: string | null;
  /** certified-outputs C1/C2: the full approval line from approvalLabel (in-app, self-approved or imported), or null. */
  approvalLine: string | null;
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
  /** certified-outputs C3 (CO-D17): hours with no applicable labor category (no cost). Admins only, like totalCost. */
  unpricedHours?: number;
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
  periodStart: CalendarDate
): Promise<TimesheetReportData | null> {
  const actor = await requireSession();
  await assertCanAccessEmployee(actor, userId);
  const start = parseCalendarDate(periodStart);
  const db = await getDb();
  // Get user info
  const [user] = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) return null;

  const periodRows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, start),
      )
    );

  const period = periodRows[0];
  // D3/§0.6: period length from its own snapshot if it has one, else its REAL effective
  // config — never an assumed default.
  const numDays = await existingPeriodLength(db, start, period?.periodNumDays);
  const periodEnd = addDays(start, numDays - 1);

  // The approval line comes from the one helper (certified-outputs C2): an in-app approver's name, "Self-approved"
  // (R2-7/CO-D6 — self-approval stays visibly auditable), or an imported approval (C1). Only an APPROVED period prints
  // an approval line; rejecting also sets reviewedBy/reviewedAt, and a rejected timesheet must never read as approved.
  const isApproved = period?.status === 'approved';
  const label = isApproved && period
    ? (await approvalLabels(db, [{ id: period.id, userId, status: period.status, reviewedBy: period.reviewedBy, reviewedAt: period.reviewedAt }], await getWorkspaceTimezone())).get(period.id)
    : undefined;
  const approvedByName = label ? (label.badge ?? label.approverName ?? label.text) : null;

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
        gte(timesheetEntries.entryDate, start),
        lt(timesheetEntries.entryDate, addDays(start, numDays)),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
      )
    );

  // Build hours map: "clinId-dayIndex" → hours
  const hoursMap = new Map<string, number>();
  for (const entry of entries) {
    const dayIndex = diffDays(start, entry.entryDate as CalendarDate);
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
    periodStart: start,
    periodEnd,
    periodStatus: period?.status ?? 'draft',
    submittedAt: period?.submittedAt ?? null,
    approvedAt: isApproved ? period?.reviewedAt ?? null : null,
    approvedBy: approvedByName,
    approvalLine: label?.text ?? null,
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
  startDate: CalendarDate,
  endDate: CalendarDate,
  contractId?: string
): Promise<CostReportEntry[]> {
  await requireAdmin();
  return getDetailedCostReportData(parseCalendarDate(startDate), parseCalendarDate(endDate), contractId);
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
  startDate: CalendarDate,
  endDate: CalendarDate
): Promise<EmployeeSummaryEntry[]> {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  if (scope !== 'all' && scope.length === 0) return [];

  const start = parseCalendarDate(startDate);
  const endDateExclusive = addDays(parseCalendarDate(endDate), 1);
  const db = await getDb();

  const rows = await db
    .select({
      employeeName: users.fullName,
      flsaExempt: users.flsaExempt,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      totalCost: pricedCostSum,
      unpricedHours: unpricedHoursSum,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    // certified-outputs C3: one cost-basis row per entry, so hours are never multiplied by overlapping assignments.
    .leftJoinLateral(COST_BASIS_LATERAL, sql`true`)
    .leftJoin(costLaborCategory, COST_LC_ON)
    .where(
      and(
        gte(timesheetEntries.entryDate, start),
        lt(timesheetEntries.entryDate, endDateExclusive),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
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
    ...(isAdmin ? {
      totalCost: Math.round(Number(row.totalCost) * 100) / 100,
      unpricedHours: Math.round(Number(row.unpricedHours) * 100) / 100,
    } : {}),
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
