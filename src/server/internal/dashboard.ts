import 'server-only';
import { and, asc, isNotNull, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { clins, contracts, timesheetEntries } from '@/db/schema';
import { COST_BASIS_LATERAL, COST_LC_ON, costLaborCategory, LATEST_REVISION, pricedCostSum, unpricedHoursSum } from './cost-basis';

type Reader = Pick<ReadDb, 'select'>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Priced cost and unpriced hours per CLIN (latest revisions, the one cost-basis resolution), each ROUNDED TO THE CENT
 * PER CLIN. The single source for contract money on the Dashboard (getContractSummaries) and Home (contractBurnSummary)
 * — feature-plan-ux-navigation-home.md §4.5: shared so the two can't drift.
 */
export async function clinCostTotals(db: Reader): Promise<Map<string, { cost: number; unpricedHours: number }>> {
  const rows = await db
    .select({ clinId: timesheetEntries.clinId, totalCost: pricedCostSum, unpricedHours: unpricedHoursSum })
    .from(timesheetEntries)
    .leftJoinLateral(COST_BASIS_LATERAL, sql`true`)
    .leftJoin(costLaborCategory, COST_LC_ON)
    .where(and(isNotNull(timesheetEntries.clinId), LATEST_REVISION))
    .groupBy(timesheetEntries.clinId);
  const out = new Map<string, { cost: number; unpricedHours: number }>();
  for (const r of rows) {
    if (r.clinId) out.set(r.clinId, { cost: round2(Number(r.totalCost)), unpricedHours: round2(Number(r.unpricedHours)) });
  }
  return out;
}

/** A contract's total from its (already per-CLIN-rounded) CLIN values: summed, then rounded — as the Dashboard does. */
export function sumRounded(values: number[]): number {
  return round2(values.reduce((s, v) => s + v, 0));
}

export interface ContractBurnRow {
  contractId: string;
  contractNumber: string;
  contractName: string;
  status: string;
  fundedValue: string | null;
  /** PRICED cost only (CO-D10/CO-D17) — label it "priced cost", never "spent". */
  pricedCost: number;
  unpricedHours: number;
}

/**
 * Every contract (any status) with its funded value, priced cost and unpriced hours — Home's burn data (§4.5). No
 * SLIN breakdown. Callers filter to active contracts for the burn card; the unpriced total uses all rows.
 */
export async function contractBurnSummary(db: Reader): Promise<ContractBurnRow[]> {
  const [allContracts, allClins, perClin] = await Promise.all([
    db.select({ id: contracts.id, contractNumber: contracts.contractNumber, name: contracts.name, status: contracts.status, fundedValue: contracts.fundedValue })
      .from(contracts).orderBy(asc(contracts.name)),
    db.select({ id: clins.id, contractId: clins.contractId }).from(clins),
    clinCostTotals(db),
  ]);
  return allContracts.map((c) => {
    const mine = allClins.filter((cl) => cl.contractId === c.id).map((cl) => perClin.get(cl.id) ?? { cost: 0, unpricedHours: 0 });
    return {
      contractId: c.id,
      contractNumber: c.contractNumber,
      contractName: c.name,
      status: c.status,
      fundedValue: c.fundedValue,
      pricedCost: sumRounded(mine.map((m) => m.cost)),
      unpricedHours: sumRounded(mine.map((m) => m.unpricedHours)),
    };
  });
}

