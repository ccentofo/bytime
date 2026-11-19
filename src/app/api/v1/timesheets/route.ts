import { NextRequest } from 'next/server';
import { getDb } from '@/db';
import { timesheetEntries, users, clins, contracts, indirectChargeCodes, importBatches } from '@/db/schema';
import { eq, and, gte, lt, sql, count } from 'drizzle-orm';
import { handleApiRequest, apiResponse, apiError } from '@/lib/api-auth';
import { addDays, isCalendarDate } from '@/lib/calendar-date';

// Date format: `startDate`/`endDate` query params and every `entryDate` in the response are
// plain 'YYYY-MM-DD' calendar-date strings — never an ISO instant/timestamp.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE_NUMBER_RE = /^\d+$/;
const MAX_PAGE_SIZE = 500;

export async function GET(request: NextRequest) {
  return handleApiRequest(request, () => listTimesheetEntries(request));
}

async function listTimesheetEntries(request: NextRequest): Promise<Response> {
  const db = await getDb();

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const userId = searchParams.get('userId');
  const pageParam = searchParams.get('page');
  const pageSizeParam = searchParams.get('pageSize');

  if (!startDate || !endDate || !isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    return apiError('startDate and endDate query parameters are required (YYYY-MM-DD format).');
  }
  // SWEEP-FINDINGS.md A3-D4: a bad parameter is a 400, not a database error (500). A pageSize over 500 is still capped.
  if (pageParam !== null && (!WHOLE_NUMBER_RE.test(pageParam) || Number(pageParam) < 1)) {
    return apiError('page must be a whole number of 1 or more.');
  }
  if (pageSizeParam !== null && (!WHOLE_NUMBER_RE.test(pageSizeParam) || Number(pageSizeParam) < 1)) {
    return apiError('pageSize must be a whole number of 1 or more.');
  }
  if (userId !== null && !UUID_RE.test(userId)) {
    return apiError('userId must be a valid UUID.');
  }
  const page = pageParam === null ? 1 : Number(pageParam);
  const pageSize = Math.min(pageSizeParam === null ? 100 : Number(pageSizeParam), MAX_PAGE_SIZE);

  const start = startDate;
  const end = addDays(endDate, 1);

  const conditions = [
    gte(timesheetEntries.entryDate, start),
    lt(timesheetEntries.entryDate, end),
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

  if (userId) {
    conditions.push(eq(timesheetEntries.userId, userId));
  }

  const rows = await db
    .select({
      id: timesheetEntries.id,
      userId: timesheetEntries.userId,
      employeeName: users.fullName,
      employeeEmail: users.email,
      clinId: timesheetEntries.clinId,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      indirectCodeId: timesheetEntries.indirectCodeId,
      indirectCode: indirectChargeCodes.code,
      indirectCategory: indirectChargeCodes.category,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
      createdAt: timesheetEntries.createdAt,
      // feature-plan-certified-outputs.md C1: provenance ('app' | 'migration'); imported rows say where from and when.
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
    .where(and(...conditions))
    // A3-D1: the entry id last makes the order total, so pages never overlap or skip rows that tie on name and date.
    .orderBy(users.fullName, timesheetEntries.entryDate, timesheetEntries.id)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // A3-D1: meta.total is every matching entry (same joins and conditions), not this page's length.
  const [{ total }] = await db
    .select({ total: count() })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .where(and(...conditions));

  return apiResponse(rows, { total, page, pageSize });
}
