import { NextRequest } from 'next/server';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';
import { getDetailedCostReportData } from '@/server/internal/reports';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');

  if (!startDate || !endDate) {
    return apiError('startDate and endDate are required.');
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return apiError('startDate and endDate must be valid dates (YYYY-MM-DD).');
  }
  if (end < start) {
    return apiError('endDate must not be before startDate.');
  }
  if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
    return apiError('The date range cannot exceed one year.');
  }
  if (contractId && !UUID_RE.test(contractId)) {
    return apiError('contractId must be a valid UUID.');
  }

  try {
    // R2-4: call the internal query directly, not the admin-only server action — API key
    // requests have no session, so requireAdmin() inside getDetailedCostReport() would always
    // reject them. validateApiKey() above is this route's own, equivalent authorization.
    const data = await getDetailedCostReportData(
      start,
      end,
      contractId ?? undefined
    );

    return apiResponse(data, { total: data.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
