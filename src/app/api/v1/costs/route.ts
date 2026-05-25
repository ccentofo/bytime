import { NextRequest } from 'next/server';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';
import { getDetailedCostReport } from '@/server/actions/reports';

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
    const data = await getDetailedCostReport(
      new Date(startDate),
      new Date(endDate),
      contractId ?? undefined
    );

    return apiResponse(data, { total: data.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
