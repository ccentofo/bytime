'use server';

import { getDb } from '@/db';
import {
  users,
  contracts,
  chargeCodes,
  clins,
  slins,
  importBatches,
  indirectChargeCodes,
  timesheetEntries,
  timesheetPeriods,
  userAssignments,
} from '@/db/schema';
import { alias } from 'drizzle-orm/pg-core';
import { eq, and, gte, lt, sql, inArray } from 'drizzle-orm';
import { existingPeriodLength } from '@/server/internal/pay-period-config';
import { approvalLabels } from '@/server/internal/approval-label';
import { COST_BASIS_LATERAL, COST_LC_ON, costLaborCategory, pricedCostSum, unpricedHoursSum } from '@/server/internal/cost-basis';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { requireSession, requireAdmin, requireApprover, getEmployeeScope, assertCanAccessEmployee } from '@/lib/session';
import { getDetailedCostReportData, type CostReportEntry } from '@/server/internal/reports';
import { addDays, diffDays, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { buildTimesheetRows, type TimesheetRow } from '@/lib/reports/timesheet-rows';

const importer = alias(users, 'importer');
// F9: a charge-code row is labelled by the charge code's own CLIN / contract / SLIN.
const codeClin = alias(clins, 'code_clin');
const codeContract = alias(contracts, 'code_contract');
const codeSlin = alias(slins, 'code_slin');

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
  /** C5: one row per true cell code from latest-revision entries (buildTimesheetRows). */
  rows: TimesheetRow[];
  dailyTotals: number[]; // sum of all entries per day
  grandTotal: number;
}

export interface EmployeeSummaryEntry {
  /** Fix round 1 (F6): rows are grouped by the employee's id — two people with the same name stay separate. */
  employeeId: string;
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

  // C5: rows from the period's LATEST-revision entries, one per true cell code (charge code / legacy CLIN / indirect
  // with category) — never from assignments. Imported cells carry their provenance (C1 "Display").
  const rows = await db
    .select({
      chargeCodeId: timesheetEntries.chargeCodeId,
      clinId: timesheetEntries.clinId,
      indirectCodeId: timesheetEntries.indirectCodeId,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      chargeCode: chargeCodes.code,
      chargeCodeName: chargeCodes.name,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
      indirectCode: indirectChargeCodes.code,
      indirectName: indirectChargeCodes.name,
      indirectCategory: indirectChargeCodes.category,
      codeClinNumber: codeClin.clinNumber,
      codeContractName: codeContract.name,
      codeContractNumber: codeContract.contractNumber,
      codeSlinNumber: codeSlin.slinNumber,
      source: timesheetEntries.source,
      changeReasonCode: timesheetEntries.changeReasonCode,
      originalMetadata: timesheetEntries.originalMetadata,
      importSourceSystem: importBatches.sourceSystem,
      importedAt: importBatches.importedAt,
      importedByName: importer.fullName,
    })
    .from(timesheetEntries)
    .leftJoin(chargeCodes, eq(timesheetEntries.chargeCodeId, chargeCodes.id))
    .leftJoin(codeClin, eq(chargeCodes.clinId, codeClin.id))
    .leftJoin(codeContract, eq(codeClin.contractId, codeContract.id))
    .leftJoin(codeSlin, eq(chargeCodes.slinId, codeSlin.id))
    .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .leftJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
    .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
    .leftJoin(importBatches, eq(timesheetEntries.importBatchId, importBatches.id))
    .leftJoin(importer, eq(importBatches.importedBy, importer.id))
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

  const built = buildTimesheetRows(rows.map((r) => ({ ...r, dayIndex: diffDays(start, r.entryDate as CalendarDate) })), numDays);

  return {
    employee: user,
    periodStart: start,
    periodEnd,
    periodStatus: period?.status ?? 'draft',
    submittedAt: period?.submittedAt ?? null,
    approvedAt: isApproved ? period?.reviewedAt ?? null : null,
    approvedBy: approvedByName,
    approvalLine: label?.text ?? null,
    rows: built.rows,
    dailyTotals: built.dailyTotals,
    grandTotal: built.grandTotal,
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
      employeeId: users.id,
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
    .groupBy(users.id, users.fullName, users.flsaExempt, contracts.name, contracts.contractNumber, clins.clinNumber)
    .orderBy(users.fullName, users.id, contracts.name, clins.clinNumber);

  const isAdmin = actor.role === 'admin';
  return rows.map((row) => ({
    employeeId: row.employeeId,
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
