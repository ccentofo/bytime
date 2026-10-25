import { NextRequest } from 'next/server';
import { getDb } from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import { eq, and, gte, lt } from 'drizzle-orm';
import { handleApiRequest, apiResponse, apiError } from '@/lib/api-auth';
import { addDays, isCalendarDate } from '@/lib/calendar-date';
import { importedPeriodIds } from '@/server/internal/import-provenance';
import { approvalLabels } from '@/server/internal/approval-label';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';

// Date format: `startDate`/`endDate` query params and every `periodStart` in the response are
// plain 'YYYY-MM-DD' calendar-date strings — never an ISO instant/timestamp.
export async function GET(request: NextRequest) {
  return handleApiRequest(request, () => listPeriods(request));
}

async function listPeriods(request: NextRequest): Promise<Response> {
  const db = await getDb();

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const status = searchParams.get('status');

  if (startDate && !isCalendarDate(startDate)) {
    return apiError('startDate must be a valid date (YYYY-MM-DD).');
  }
  if (endDate && !isCalendarDate(endDate)) {
    return apiError('endDate must be a valid date (YYYY-MM-DD).');
  }

  const conditions = [];

  if (startDate && isCalendarDate(startDate)) {
    conditions.push(gte(timesheetPeriods.periodStart, startDate));
  }
  if (endDate && isCalendarDate(endDate)) {
    conditions.push(lt(timesheetPeriods.periodStart, addDays(endDate, 1)));
  }
  if (status) {
    conditions.push(eq(timesheetPeriods.status, status as any));
  }

  const rows = await db
    .select({
      id: timesheetPeriods.id,
      userId: timesheetPeriods.userId,
      employeeName: users.fullName,
      employeeEmail: users.email,
      periodStart: timesheetPeriods.periodStart,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt,
      reviewedBy: timesheetPeriods.reviewedBy,
    })
    .from(timesheetPeriods)
    .innerJoin(users, eq(timesheetPeriods.userId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(timesheetPeriods.periodStart);

  // feature-plan-certified-outputs.md C1: an imported approval is never attributed to a CadenzPoint user —
  // approvedBy null + approvalSource 'migration'. Additive fields; reviewedBy is unchanged.
  const imported = await importedPeriodIds(db, rows.map((r) => r.id));
  // certified-outputs C2 (CO-D6): selfApproved from the one approval-label helper.
  const labels = await approvalLabels(db, rows, await getWorkspaceTimezone());
  const decided = (s: string) => s === 'approved' || s === 'rejected';
  return apiResponse(rows.map((r) => ({
    ...r,
    approvalSource: decided(r.status) ? (imported.has(r.id) ? 'migration' : 'app') : null,
    approvedBy: r.status === 'approved' && !imported.has(r.id) ? r.reviewedBy : null,
    selfApproved: labels.get(r.id)?.selfApproved ?? false,
  })), { total: rows.length });
}
