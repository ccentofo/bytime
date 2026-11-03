import 'server-only';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { clins, contracts, slins, timesheetEntries } from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import { COST_BASIS_LATERAL, COST_LC_ON, costLaborCategory, LATEST_REVISION, pricedCostSum, unpricedHoursSum } from './cost-basis';
import { clinCostTotals, sumRounded } from './dashboard';

type Reader = Pick<ReadDb, 'select'>;
export type RecordStatus = 'active' | 'inactive' | 'closed';

/** Funded amount (as stored) and the money the hours add up to. */
export type Money = { funded: string | null; hours: number; pricedCost: number; unpricedHours: number };
export interface SlinNode extends Money { id: string; slinNumber: string; description: string | null; status: RecordStatus }
export interface ClinNode extends Money { id: string; clinNumber: string; description: string | null; status: RecordStatus; slins: SlinNode[] }
export interface ContractNode extends Money {
  id: string; contractNumber: string; name: string; description: string | null; contractType: 'prime' | 'sub'; status: RecordStatus;
  startDate: CalendarDate | null; endDate: CalendarDate | null; ceiling: string | null; clins: ClinNode[];
}
export interface ContractsOverview {
  contracts: ContractNode[];
  /** Money and counts over ACTIVE contracts; unpricedHoursAll over ALL contracts (Home's figure) — C2. */
  totals: { activeContracts: number; funded: number; pricedCost: number; unpricedHoursAll: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ZERO = { cost: 0, unpricedHours: 0, totalHours: 0 };

/**
 * The Contracts page's read (feature-plan-ux-kit-contracts.md §4.1): five queries — contracts, CLINs, SLINs, per-CLIN
 * money (clinCostTotals, shared with Home so the two agree to the cent, C5) and per-SLIN money (one lateral query).
 * Every aggregate inner-joins `clins` and uses the latest revision. A contract's money is sumRounded of its CLINs (SLIN
 * money is a subset of its CLIN's, never added on top). INTERNAL, no guard — getContractsOverview authorizes.
 */
export async function getContractsOverviewInternal(db: Reader): Promise<ContractsOverview> {
  const [contractRows, clinRows, slinRows, perClin, perSlinRows] = await Promise.all([
    db.select().from(contracts).orderBy(asc(contracts.name)),
    db.select().from(clins).orderBy(asc(clins.clinNumber)),
    db.select().from(slins).orderBy(asc(slins.slinNumber)),
    clinCostTotals(db),
    db.select({
      slinId: timesheetEntries.slinId,
      totalCost: pricedCostSum,
      unpricedHours: unpricedHoursSum,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
    })
      .from(timesheetEntries)
      .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
      .leftJoinLateral(COST_BASIS_LATERAL, sql`true`)
      .leftJoin(costLaborCategory, COST_LC_ON)
      .where(and(isNotNull(timesheetEntries.slinId), LATEST_REVISION))
      .groupBy(timesheetEntries.slinId),
  ]);

  const perSlin = new Map<string, { cost: number; unpricedHours: number; totalHours: number }>();
  for (const r of perSlinRows) {
    if (r.slinId) perSlin.set(r.slinId, { cost: round2(Number(r.totalCost)), unpricedHours: round2(Number(r.unpricedHours)), totalHours: round2(Number(r.totalHours)) });
  }

  const nodes: ContractNode[] = contractRows.map((c) => {
    const clinNodes: ClinNode[] = clinRows.filter((cl) => cl.contractId === c.id).map((cl) => {
      const m = perClin.get(cl.id) ?? ZERO;
      return {
        id: cl.id, clinNumber: cl.clinNumber, description: cl.description, status: cl.status as RecordStatus,
        funded: cl.fundedAmount, hours: m.totalHours, pricedCost: m.cost, unpricedHours: m.unpricedHours,
        slins: slinRows.filter((s) => s.clinId === cl.id).map((s) => {
          const sm = perSlin.get(s.id) ?? ZERO;
          return {
            id: s.id, slinNumber: s.slinNumber, description: s.description, status: s.status as RecordStatus,
            funded: s.fundedAmount, hours: sm.totalHours, pricedCost: sm.cost, unpricedHours: sm.unpricedHours,
          };
        }),
      };
    });
    return {
      id: c.id, contractNumber: c.contractNumber, name: c.name, description: c.description,
      contractType: c.contractType === 'sub' ? 'sub' : 'prime', status: c.status as RecordStatus,
      startDate: c.startDate as CalendarDate | null, endDate: c.endDate as CalendarDate | null, ceiling: c.ceilingValue,
      funded: c.fundedValue,
      hours: sumRounded(clinNodes.map((n) => n.hours)),
      pricedCost: sumRounded(clinNodes.map((n) => n.pricedCost)),
      unpricedHours: sumRounded(clinNodes.map((n) => n.unpricedHours)),
      clins: clinNodes,
    };
  });

  const active = nodes.filter((n) => n.status === 'active');
  return {
    contracts: nodes,
    totals: {
      activeContracts: active.length,
      funded: round2(active.reduce((s, n) => s + (parseFloat(n.funded ?? '') || 0), 0)),
      pricedCost: sumRounded(active.map((n) => n.pricedCost)),
      unpricedHoursAll: sumRounded(nodes.map((n) => n.unpricedHours)),
    },
  };
}
