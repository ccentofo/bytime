import { NextRequest } from 'next/server';
import { getDb } from '@/db';
import { timesheetEntries, timesheetPeriods, users, clins, contracts, indirectChargeCodes, importBatches } from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { handleApiRequest, apiResponse, apiError } from '@/lib/api-auth';
import { addDays, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { existingPeriodLength } from '@/server/internal/pay-period-config';
import { importedPeriodIds } from '@/server/internal/import-provenance';

// Date format: `startDate`/`endDate` query params and every `periodStart`/`entryDate` in the
// response are plain 'YYYY-MM-DD' calendar-date strings — never an ISO instant/timestamp.
export async function GET(request: NextRequest) {
  return handleApiRequest(request, () => listApprovedTimesheets(request));
}

async function listApprovedTimesheets(request: NextRequest): Promise<Response> {
  const db = await getDb();

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  if (!startDate || !endDate || !isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    return apiError('startDate and endDate are required (YYYY-MM-DD).');
  }

  const start = startDate;
  const end = addDays(endDate, 1);

  // Get approved periods in the date range
  const approvedPeriods = await db
    .select({
      id: timesheetPeriods.id,
      userId: timesheetPeriods.userId,
      reviewedBy: timesheetPeriods.reviewedBy,
      periodStart: timesheetPeriods.periodStart,
      periodNumDays: timesheetPeriods.periodNumDays,
      approvedAt: timesheetPeriods.reviewedAt,
    })
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.status, 'approved'),
        gte(timesheetPeriods.periodStart, start),
        lt(timesheetPeriods.periodStart, end),
      )
    );

  // feature-plan-certified-outputs.md C1: imported approvals are labelled, never attributed to a CadenzPoint user.
  const imported = await importedPeriodIds(db, approvedPeriods.map((p) => p.id));

  // For each approved period, get the latest-revision entries
  const results = [];
  for (const period of approvedPeriods) {
    // D3/§0.6: bound the window to this period's REAL length — the original query had no
    // upper bound at all here, so it silently pulled every later period's entries too.
    const pStart = period.periodStart as CalendarDate;
    // Session-free and non-throwing: API-key callers have no session, and a stored period must
    // stay readable even if it doesn't line up with today's schedule.
    const numDays = await existingPeriodLength(db, pStart, period.periodNumDays);
    const pEndExclusive = addDays(pStart, numDays);
    const entries = await db
      .select({
        userId: timesheetEntries.userId,
        employeeName: users.fullName,
        clinNumber: clins.clinNumber,
        contractNumber: contracts.contractNumber,
        indirectCode: indirectChargeCodes.code,
        entryDate: timesheetEntries.entryDate,
        hours: timesheetEntries.hours,
        source: timesheetEntries.source,
        importedFrom: importBatches.sourceSystem,
        importedAt: importBatches.importedAt,
      })
      .from(timesheetEntries)
      .innerJoin(users, eq(timesheetEntries.userId, users.id))
      .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
      .leftJoin(contracts, eq(clins.contractId, contracts.id))
      .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
      .leftJoin(importBatches, eq(timesheetEntries.importBatchId, importBatches.id))
      .where(
        and(
          eq(timesheetEntries.userId, period.userId),
          gte(timesheetEntries.entryDate, pStart),
          lt(timesheetEntries.entryDate, pEndExclusive),
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

    const isImported = imported.has(period.id);
    results.push({
      periodStart: period.periodStart,
      approvedAt: period.approvedAt,
      approvedBy: isImported ? null : period.reviewedBy,
      approvalSource: isImported ? 'migration' : 'app',
      entries,
    });
  }

  return apiResponse(results, { total: results.length });
}
