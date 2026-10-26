import 'server-only';
import { getDb } from '@/db';
import { users, contracts, clins, slins, timesheetEntries } from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { addDays, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { COST_BASIS_LATERAL, COST_LC_ON, costBasisFields, costLaborCategory, type CostBasis } from './cost-basis';

export interface CostReportEntry {
  employeeName: string;
  employeeEmail: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  slinNumber: string | null;
  lcatCode: string;
  lcatTitle: string;
  hourlyRate: number;
  totalHours: number;
  totalCost: number;
  entryDate: string; // YYYY-MM-DD
  /** feature-plan-certified-outputs.md C3 (CO-D10): 'unpriced' hours count in hours but carry no cost. */
  costBasis: 'priced' | 'unpriced';
  /** Why it is unpriced ('no-category' | 'conflict'), else null — see the Unpriced hours report. */
  unpricedReason: Exclude<CostBasis, 'priced'> | null;
  /** The entry's hours when unpriced, else 0 (CO-D17: shown next to every cost). */
  unpricedHours: number;
}

/**
 * Detailed cost report query. Each row = one employee + one CLIN + one day with hours and cost.
 *
 * INTERNAL — not a server action, so it carries no guard of its own. Callers must authorize
 * first: the admin-only getDetailedCostReport() server action (requireAdmin), and the
 * /api/v1/costs route (validateApiKey) — API key requests have no session to pass requireAdmin,
 * which is exactly why this was split out (R2-4).
 */
export async function getDetailedCostReportData(
  startDate: CalendarDate,
  endDate: CalendarDate,
  contractId?: string
): Promise<CostReportEntry[]> {
  const db = await getDb();
  const start = parseCalendarDate(startDate);
  const endDateExclusive = addDays(parseCalendarDate(endDate), 1);

  const conditions = [
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
  ];

  if (contractId) {
    conditions.push(eq(contracts.id, contractId));
  }

  const rows = await db
    .select({
      employeeName: users.fullName,
      employeeEmail: users.email,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      slinNumber: slins.slinNumber,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      ...costBasisFields,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
    // certified-outputs C3: the one cost-basis resolution — exactly one row per entry (no duplicate rows).
    .leftJoinLateral(COST_BASIS_LATERAL, sql`true`)
    .leftJoin(costLaborCategory, COST_LC_ON)
    .where(and(...conditions))
    .orderBy(contracts.name, clins.clinNumber, users.fullName, timesheetEntries.entryDate);

  return rows.map((row): CostReportEntry => {
    const hours = parseFloat(row.hours) || 0;
    const priced = row.basis === 'priced';
    const rate = priced ? parseFloat(row.hourlyRate ?? '0') || 0 : 0;
    return {
      employeeName: row.employeeName,
      employeeEmail: row.employeeEmail,
      contractName: row.contractName,
      contractNumber: row.contractNumber,
      clinNumber: row.clinNumber,
      slinNumber: row.slinNumber,
      lcatCode: priced ? row.lcatCode ?? '—' : '—',
      lcatTitle: priced ? row.lcatTitle ?? '' : 'Unpriced',
      hourlyRate: rate,
      totalHours: Math.round(hours * 100) / 100,
      totalCost: Math.round(hours * rate * 100) / 100,
      entryDate: row.entryDate,
      costBasis: priced ? 'priced' : 'unpriced',
      unpricedReason: row.basis === 'priced' ? null : row.basis,
      unpricedHours: priced ? 0 : Math.round(hours * 100) / 100,
    };
  });
}
