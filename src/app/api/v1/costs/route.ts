import { NextRequest } from 'next/server';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';
import { getDetailedCostReportData } from '@/server/internal/reports';

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

  try {
    // R2-4: call the internal query directly, not the admin-only server action — API key
    // requests have no session, so requireAdmin() inside getDetailedCostReport() would always
    // reject them. validateApiKey() above is this route's own, equivalent authorization.
    const data = await getDetailedCostReportData(
      new Date(startDate),
      new Date(endDate),
      contractId ?? undefined
    );

    return apiResponse(data, { total: data.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
