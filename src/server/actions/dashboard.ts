'use server';

import { db } from '@/db';
import {
  contracts,
  clins,
  slins,
  timesheetEntries,
  laborCategories,
  userLaborCategories,
  users,
} from '@/db/schema';
import { eq, and, sql, gte, lt } from 'drizzle-orm';
import dayjs from 'dayjs';

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
  totalCost: number;
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
 * RATE ACCURACY: Rate lookups now respect effective_date and end_date on
 * user_labor_categories, ensuring costs reflect the rate in effect when hours
 * were worked (CAS 418 compliance).
 */
export async function getContractSummaries(): Promise<ContractSummary[]> {
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
                AND te2.clin_id = ${timesheetEntries.clinId}
                AND te2.entry_date = ${timesheetEntries.entryDate}
            )`
          ),
        )
      )
      .groupBy(timesheetEntries.clinId),

    // Query 5: Total cost per CLIN (latest revision × effective rate)
    db
      .select({
        clinId: timesheetEntries.clinId,
        totalCost: sql<number>`COALESCE(SUM(
          CAST(${timesheetEntries.hours} AS NUMERIC) *
          CAST(${laborCategories.hourlyRate} AS NUMERIC)
        ), 0)`,
      })
      .from(timesheetEntries)
      .innerJoin(
        userLaborCategories,
        and(
          eq(userLaborCategories.userId, timesheetEntries.userId),
          sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
          sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
        )
      )
      .innerJoin(
        laborCategories,
        and(
          eq(laborCategories.id, userLaborCategories.laborCategoryId),
          eq(laborCategories.clinId, timesheetEntries.clinId),
          eq(laborCategories.status, 'active'),
        )
      )
      .where(
        and(
          sql`${timesheetEntries.clinId} IS NOT NULL`,
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
      )
      .groupBy(timesheetEntries.clinId),

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
                AND te2.clin_id = ${timesheetEntries.clinId}
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
        totalCost: sql<number>`COALESCE(SUM(
          CAST(${timesheetEntries.hours} AS NUMERIC) *
          CAST(${laborCategories.hourlyRate} AS NUMERIC)
        ), 0)`,
      })
      .from(timesheetEntries)
      .innerJoin(
        userLaborCategories,
        and(
          eq(userLaborCategories.userId, timesheetEntries.userId),
          sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
          sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
        )
      )
      .innerJoin(
        laborCategories,
        and(
          eq(laborCategories.id, userLaborCategories.laborCategoryId),
          eq(laborCategories.clinId, timesheetEntries.clinId),
          eq(laborCategories.status, 'active'),
        )
      )
      .where(
        and(
          sql`${timesheetEntries.slinId} IS NOT NULL`,
          eq(
            timesheetEntries.revisionNumber,
            sql`(
              SELECT MAX(te2.revision_number)
              FROM timesheet_entries te2
              WHERE te2.user_id = ${timesheetEntries.userId}
                AND te2.clin_id = ${timesheetEntries.clinId}
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
  for (const row of costData) {
    if (row.clinId) {
      costMap.set(row.clinId, Math.round(Number(row.totalCost) * 100) / 100);
    }
  }

  const slinHoursMap = new Map<string, number>();
  for (const row of slinHoursData) {
    if (row.slinId) {
      slinHoursMap.set(row.slinId, Math.round(Number(row.totalHours) * 100) / 100);
    }
  }

  const slinCostMap = new Map<string, number>();
  for (const row of slinCostData) {
    if (row.slinId) {
      slinCostMap.set(row.slinId, Math.round(Number(row.totalCost) * 100) / 100);
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
      }));

      return {
        clinId: clin.id,
        clinNumber: clin.clinNumber,
        description: clin.description,
        fundedAmount: clin.fundedAmount,
        status: clin.status,
        totalHours: hoursMap.get(clin.id) ?? 0,
        totalCost: costMap.get(clin.id) ?? 0,
        slinSummaries,
      };
    });

    const totalHours = clinSummaries.reduce((sum, c) => sum + c.totalHours, 0);
    const totalCost = clinSummaries.reduce((sum, c) => sum + c.totalCost, 0);

    summaries.push({
      contractId: contract.id,
      contractNumber: contract.contractNumber,
      contractName: contract.name,
      contractType: contract.contractType ?? 'prime',
      status: contract.status,
      fundedValue: contract.fundedValue,
      ceilingValue: contract.ceilingValue,
      totalHours: Math.round(totalHours * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
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
 * RATE ACCURACY: Uses effective-date-aware rate lookup via user_labor_categories
 * JOIN conditions, ensuring each hour is costed at the rate that was in effect
 * on the date the work was performed.
 */
export async function getPeriodCostReport(
  startDate: Date,
  endDate: Date
): Promise<PeriodCostEntry[]> {
  const endDateExclusive = dayjs(endDate).add(1, 'day').toDate();

  // Single optimized query: aggregate hours and costs by (user, clin, slin, lcat)
  const rows = await db
    .select({
      userName: users.fullName,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      slinNumber: slins.slinNumber,
      lcatCode: sql<string>`COALESCE(${laborCategories.lcatCode}, '—')`,
      lcatTitle: sql<string>`COALESCE(${laborCategories.title}, 'No LCAT')`,
      hourlyRate: sql<string>`COALESCE(${laborCategories.hourlyRate}, '0')`,
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
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
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
      )
    )
    .groupBy(
      users.fullName,
      contracts.name,
      contracts.contractNumber,
      clins.clinNumber,
      slins.slinNumber,
      laborCategories.lcatCode,
      laborCategories.title,
      laborCategories.hourlyRate,
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
  }));
}
