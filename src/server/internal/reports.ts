import 'server-only';
import { getDb } from '@/db';
import {
  users,
  contracts,
  clins,
  slins,
  timesheetEntries,
  laborCategories,
  userLaborCategories,
} from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import dayjs from 'dayjs';

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
  startDate: Date,
  endDate: Date,
  contractId?: string
): Promise<CostReportEntry[]> {
  const db = await getDb();
  const endDateExclusive = dayjs(endDate).add(1, 'day').toDate();

  const conditions = [
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
      lcatCode: laborCategories.lcatCode,
      lcatTitle: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
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
    .where(and(...conditions))
    .orderBy(contracts.name, clins.clinNumber, users.fullName, timesheetEntries.entryDate);

  return rows.map((row) => {
    const hours = parseFloat(row.hours) || 0;
    const rate = parseFloat(row.hourlyRate ?? '0') || 0;
    return {
      employeeName: row.employeeName,
      employeeEmail: row.employeeEmail,
      contractName: row.contractName,
      contractNumber: row.contractNumber,
      clinNumber: row.clinNumber,
      slinNumber: row.slinNumber,
      lcatCode: row.lcatCode ?? '—',
      lcatTitle: row.lcatTitle ?? 'No LCAT',
      hourlyRate: rate,
      totalHours: Math.round(hours * 100) / 100,
      totalCost: Math.round(hours * rate * 100) / 100,
      entryDate: dayjs(row.entryDate).format('YYYY-MM-DD'),
    };
  });
}
