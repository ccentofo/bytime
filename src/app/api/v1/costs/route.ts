import { NextRequest } from 'next/server';
import { handleApiRequest, apiResponse, apiError } from '@/lib/api-auth';
import { getDetailedCostReportData } from '@/server/internal/reports';
import { isCalendarDate, isBefore, diffDays } from '@/lib/calendar-date';

// Date format: `startDate`/`endDate` query params and every `entryDate` in the response are
// plain 'YYYY-MM-DD' calendar-date strings — never an ISO instant/timestamp.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  return handleApiRequest(request, () => getCostReport(request));
}

async function getCostReport(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');

  if (!startDate || !endDate) {
    return apiError('startDate and endDate are required.');
  }
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    return apiError('startDate and endDate must be valid dates (YYYY-MM-DD).');
  }
  if (isBefore(endDate, startDate)) {
    return apiError('endDate must not be before startDate.');
  }
  if (diffDays(startDate, endDate) > 366) {
    return apiError('The date range cannot exceed one year.');
  }
  if (contractId && !UUID_RE.test(contractId)) {
    return apiError('contractId must be a valid UUID.');
  }

  // R2-4: call the internal query directly, not the admin-only server action — API key
  // requests have no session, so requireAdmin() inside getDetailedCostReport() would always
  // reject them. handleApiRequest() in GET is this route's own, equivalent authorization.
  const data = await getDetailedCostReportData(
    startDate,
    endDate,
    contractId ?? undefined
  );

  return apiResponse(data, { total: data.length });
}
