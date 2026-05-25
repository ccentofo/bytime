import { NextRequest } from 'next/server';
import { db } from '@/db';
import { timesheetEntries, users, clins, contracts, indirectChargeCodes } from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const userId = searchParams.get('userId');
  const page = parseInt(searchParams.get('page') ?? '1');
  const pageSize = Math.min(parseInt(searchParams.get('pageSize') ?? '100'), 500);

  if (!startDate || !endDate) {
    return apiError('startDate and endDate query parameters are required (YYYY-MM-DD format).');
  }

  try {
    const start = new Date(startDate);
    const end = dayjs(endDate).add(1, 'day').toDate();

    const conditions = [
      gte(timesheetEntries.entryDate, start),
      lt(timesheetEntries.entryDate, end),
      eq(
        timesheetEntries.revisionNumber,
        sql`(
          SELECT MAX(te2.revision_number)
          FROM timesheet_entries te2
          WHERE te2.user_id = ${timesheetEntries.userId}
            AND COALESCE(te2.clin_id, te2.indirect_code_id) = COALESCE(${timesheetEntries.clinId}, ${timesheetEntries.indirectCodeId})
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
      })
      .from(timesheetEntries)
      .innerJoin(users, eq(timesheetEntries.userId, users.id))
      .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
      .leftJoin(contracts, eq(clins.contractId, contracts.id))
      .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
      .where(and(...conditions))
      .orderBy(users.fullName, timesheetEntries.entryDate)
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return apiResponse(rows, { total: rows.length, page, pageSize });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
