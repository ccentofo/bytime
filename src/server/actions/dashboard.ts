'use server';

import { getDb } from '@/db';
import {
  contracts,
  clins,
  slins,
  timesheetEntries,
  users,
} from '@/db/schema';
import { COST_BASIS_LATERAL, COST_LC_ON, costLaborCategory, pricedCostSum, unpricedHoursSum } from '@/server/internal/cost-basis';
import { clinCostTotals, sumRounded } from '@/server/internal/dashboard';
import { eq, and, sql, gte, lt } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { addDays, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';

// ---------------------------------------------------------------------------
// Types (UNCHANGED — must match DashboardClient.tsx expectations)
// ---------------------------------------------------------------------------

export interface SlinSummary {
  slinId: string;
  slinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: string;
  totalHours: number;
  /** certified-outputs C3: PRICED cost only (CO-D10); unpricedHours carry no cost and are shown beside it (CO-D17). */
  totalCost: number;
  unpricedHours: number;
}

export interface ContractSummary {
  contractId: string;
  contractNumber: string;
  contractName: string;
  contractType: string;
  status: string;
  fundedValue: string | null;
  ceilingValue: string | null;
  totalHours: number;
  totalCost: number;
  unpricedHours: number;
  clinSummaries: ClinSummary[];
}

export interface ClinSummary {
  clinId: string;
  clinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: string;
  totalHours: number;
  totalCost: number;
  unpricedHours: number;
  slinSummaries: SlinSummary[];
}

export interface PeriodCostEntry {
  userName: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  slinNumber: string | null;
  lcatCode: string;
  lcatTitle: string;
  hourlyRate: string;
  totalHours: number;
  totalCost: number;
  /** certified-outputs C3: 'unpriced' rows group the hours with no applicable labor category (no cost). */
  costBasis: 'priced' | 'unpriced';
  unpricedHours: number;
}

// ---------------------------------------------------------------------------
// Dashboard Queries (OPTIMIZED — max 4 queries for summaries, 1 for report)
// ---------------------------------------------------------------------------

/**
 * Get a cost summary for all contracts.
 * Calculates total hours and cost (hours × effective rate) per contract and CLIN.
 *
 * OPTIMIZATION: Replaces the previous N+1 loop approach with batch queries:
 *   1. All contracts (1 query)
 *   2. All CLINs (1 query)
 *   3. All hours by CLIN — latest revision only (1 query)
 *   4. All costs by CLIN — latest revision with effective-date rate lookup (1 query)
 *
 * COST BASIS (feature-plan-certified-outputs.md C3): every cost goes through src/server/internal/cost-basis.ts —
 * the labor category is resolved per entry (charge code → SLIN assignment → CLIN assignment, effective on the entry
 * date); entries with none or with conflicting categories are UNPRICED (hours counted, no cost, reported beside the
 * cost). Rates are the categories' CURRENT rates (CO-D7 interim — effective-dated rates are a separate blueprint).
 */
export async function getContractSummaries(): Promise<ContractSummary[]> {
  await requireAdmin();
  const db = await getDb();
  // All 7 queries run in parallel — zero dependencies between them
  const [allContracts, allClins, allSlins, hoursData, costData, slinHoursData, slinCostData] = await Promise.all([
    // Query 1: All contracts
    db.select().from(contracts).orderBy(contracts.name),

    // Query 2: All CLINs
    db.select().from(clins).orderBy(clins.clinNumber),

    // Query 3: All SLINs
    db.select().from(slins).orderBy(slins.slinNumber),

    // Query 4: Total hours per CLIN (latest revision only, direct entries only)
    db
      .select({
        clinId: timesheetEntries.clinId,
        totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      })
      .from(timesheetEntries)
      .where(
        and(
          sql`${timesheetEntries.clinId} IS NOT NULL`,
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
      )
      .groupBy(timesheetEntries.clinId),

    // Query 5: priced cost + unpriced hours per CLIN, rounded per CLIN — the shared helper (also Home's burn data)
    clinCostTotals(db),

    // Query 6: Total hours per SLIN (latest revision only)
    db
      .select({
        slinId: timesheetEntries.slinId,
        totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      })
      .from(timesheetEntries)
      .where(
        and(
          sql`${timesheetEntries.slinId} IS NOT NULL`,
          eq(
            timesheetEntries.revisionNumber,
            sql`(
              SELECT MAX(te2.revision_number)
              FROM timesheet_entries te2
              WHERE te2.user_id = ${timesheetEntries.userId}
                AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
                AND te2.entry_date = ${timesheetEntries.entryDate}
            )`
          )
        )
      )
      .groupBy(timesheetEntries.slinId),

    // Query 7: Total cost per SLIN (latest revision × effective rate)
    db
      .select({
        slinId: timesheetEntries.slinId,
        totalCost: pricedCostSum,
        unpricedHours: unpricedHoursSum,
      })
      .from(timesheetEntries)
      // certified-outputs C3: the one cost-basis resolution (CO-D10) — never doubles on overlapping assignments.
      .leftJoinLateral(COST_BASIS_LATERAL, sql`true`)
      .leftJoin(costLaborCategory, COST_LC_ON)
      .where(
        and(
          sql`${timesheetEntries.slinId} IS NOT NULL`,
          eq(
            timesheetEntries.revisionNumber,
            sql`(
              SELECT MAX(te2.revision_number)
              FROM timesheet_entries te2
              WHERE te2.user_id = ${timesheetEntries.userId}
                AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
                AND te2.entry_date = ${timesheetEntries.entryDate}
            )`
          )
        )
      )
      .groupBy(timesheetEntries.slinId),
  ]);

  // Build lookup maps
  const hoursMap = new Map<string, number>();
  for (const row of hoursData) {
    if (row.clinId) {
      hoursMap.set(row.clinId, Math.round(Number(row.totalHours) * 100) / 100);
    }
  }

  const costMap = new Map<string, number>();
  const unpricedMap = new Map<string, number>();
  for (const [clinId, v] of costData) {
    costMap.set(clinId, v.cost);
    unpricedMap.set(clinId, v.unpricedHours);
  }

  const slinHoursMap = new Map<string, number>();
  for (const row of slinHoursData) {
    if (row.slinId) {
      slinHoursMap.set(row.slinId, Math.round(Number(row.totalHours) * 100) / 100);
    }
  }

  const slinCostMap = new Map<string, number>();
  const slinUnpricedMap = new Map<string, number>();
  for (const row of slinCostData) {
    if (row.slinId) {
      slinCostMap.set(row.slinId, Math.round(Number(row.totalCost) * 100) / 100);
      slinUnpricedMap.set(row.slinId, Math.round(Number(row.unpricedHours) * 100) / 100);
    }
  }

  // Group SLINs by CLIN
  const slinsByClin = new Map<string, (typeof allSlins)[number][]>();
  for (const slin of allSlins) {
    const existing = slinsByClin.get(slin.clinId) ?? [];
    existing.push(slin);
    slinsByClin.set(slin.clinId, existing);
  }

  // Group CLINs by contract
  const clinsByContract = new Map<string, (typeof allClins)[number][]>();
  for (const clin of allClins) {
    const existing = clinsByContract.get(clin.contractId) ?? [];
    existing.push(clin);
    clinsByContract.set(clin.contractId, existing);
  }

  // Assemble summaries
  const summaries: ContractSummary[] = [];

  for (const contract of allContracts) {
    const contractClins = clinsByContract.get(contract.id) ?? [];

    const clinSummaries: ClinSummary[] = contractClins.map((clin) => {
      const clinSlins = slinsByClin.get(clin.id) ?? [];

      const slinSummaries: SlinSummary[] = clinSlins.map((slin) => ({
        slinId: slin.id,
        slinNumber: slin.slinNumber,
        description: slin.description,
        fundedAmount: slin.fundedAmount,
        status: slin.status,
        totalHours: slinHoursMap.get(slin.id) ?? 0,
        totalCost: slinCostMap.get(slin.id) ?? 0,
        unpricedHours: slinUnpricedMap.get(slin.id) ?? 0,
      }));

      return {
        clinId: clin.id,
        clinNumber: clin.clinNumber,
        description: clin.description,
        fundedAmount: clin.fundedAmount,
        status: clin.status,
        totalHours: hoursMap.get(clin.id) ?? 0,
        totalCost: costMap.get(clin.id) ?? 0,
        unpricedHours: unpricedMap.get(clin.id) ?? 0,
        slinSummaries,
      };
    });

    const totalHours = clinSummaries.reduce((sum, c) => sum + c.totalHours, 0);

    summaries.push({
      contractId: contract.id,
      contractNumber: contract.contractNumber,
      contractName: contract.name,
      contractType: contract.contractType ?? 'prime',
      status: contract.status,
      fundedValue: contract.fundedValue,
      ceilingValue: contract.ceilingValue,
      totalHours: Math.round(totalHours * 100) / 100,
      totalCost: sumRounded(clinSummaries.map((c) => c.totalCost)),
      unpricedHours: sumRounded(clinSummaries.map((c) => c.unpricedHours)),
      clinSummaries,
    });
  }

  return summaries;
}

/**
 * Get a period-based cost report showing hours × effective rate by employee/CLIN/LCAT.
 * Used for generating invoicing data and incurred cost submissions.
 *
 * OPTIMIZATION: Single query with JOINs and GROUP BY replaces the previous
 * approach of fetching all entries, aggregating in memory, then issuing
 * per-aggregate queries for user/CLIN/LCAT context.
 *
 * COST BASIS: the one resolution in src/server/internal/cost-basis.ts (C3); unpriced hours form their own rows.
 * Rates are current rates (CO-D7 interim).
 */
export async function getPeriodCostReport(
  startDate: CalendarDate,
  endDate: CalendarDate
): Promise<PeriodCostEntry[]> {
  await requireAdmin();
  const db = await getDb();
  const start = parseCalendarDate(startDate);
  const endDateExclusive = addDays(parseCalendarDate(endDate), 1);

  // Single optimized query: aggregate hours and costs by (user, clin, slin, lcat)
  const rows = await db
    .select({
      userName: users.fullName,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      slinNumber: slins.slinNumber,
      basis: sql<string>`CASE WHEN cost_basis.basis = 'priced' THEN 'priced' ELSE 'unpriced' END`,
      lcatCode: sql<string>`COALESCE("cost_lc"."lcat_code", '—')`,
      lcatTitle: sql<string>`COALESCE("cost_lc"."title", 'Unpriced')`,
      // Dated rates D1.4: the rate in effect on each entry's date — one row per rate when it changed inside the range.
      hourlyRate: sql<string>`COALESCE(cost_basis.applied_rate, 0)::text`,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      totalCost: pricedCostSum,
      unpricedHours: unpricedHoursSum,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
    // certified-outputs C3: the one cost-basis resolution; unpriced hours group into their own 'Unpriced' rows.
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
      )
    )
    .groupBy(
      users.fullName,
      contracts.name,
      contracts.contractNumber,
      clins.clinNumber,
      slins.slinNumber,
      sql`CASE WHEN cost_basis.basis = 'priced' THEN 'priced' ELSE 'unpriced' END`,
      costLaborCategory.lcatCode,
      costLaborCategory.title,
      // Grouped over the per-entry lateral's column — never by re-evaluating the rate rule (trap T14).
      sql`cost_basis.applied_rate`,
    )
    .orderBy(contracts.name, clins.clinNumber, users.fullName);

  return rows.map((row) => ({
    userName: row.userName,
    contractName: row.contractName,
    contractNumber: row.contractNumber,
    clinNumber: row.clinNumber,
    slinNumber: row.slinNumber ?? null,
    lcatCode: row.lcatCode,
    lcatTitle: row.lcatTitle,
    hourlyRate: row.hourlyRate,
    totalHours: Math.round(Number(row.totalHours) * 100) / 100,
    totalCost: Math.round(Number(row.totalCost) * 100) / 100,
    costBasis: row.basis === 'priced' ? 'priced' : 'unpriced',
    unpricedHours: Math.round(Number(row.unpricedHours) * 100) / 100,
  }));
}
