import { NextRequest, NextResponse } from 'next/server';
import { getDetailedCostReport } from '@/server/actions/reports';
import { generateCsv } from '@/lib/reports/csv-generator';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import { isCalendarDate } from '@/lib/calendar-date';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');

  if (!startDate || !endDate || !isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    return NextResponse.json({ error: 'Missing or invalid startDate/endDate (expected YYYY-MM-DD)' }, { status: 400 });
  }

  let data;
  try {
    // Dollar data — admin-only. getDetailedCostReport enforces this via requireAdmin().
    data = await getDetailedCostReport(
      startDate,
      endDate,
      contractId ?? undefined
    );
  } catch (error) {
    return guardErrorResponse(error);
  }

  const csv = generateCsv(data, [
    { key: 'employeeName', header: 'Employee' },
    { key: 'contractName', header: 'Contract' },
    { key: 'contractNumber', header: 'Contract Number' },
    { key: 'clinNumber', header: 'CLIN' },
    { key: 'slinNumber', header: 'SLIN' },
    { key: 'lcatCode', header: 'LCAT Code' },
    { key: 'lcatTitle', header: 'LCAT Title' },
    { key: 'hourlyRate', header: 'Rate ($/hr)' },
    { key: 'entryDate', header: 'Date' },
    { key: 'totalHours', header: 'Hours' },
    { key: 'totalCost', header: 'Cost ($)' },
    { key: 'costBasis', header: 'Cost Basis' },
  ]);
  // certified-outputs C3 (CO-D17 / ruling Q6): the unpriced count travels with the cost total, plus the CO-D7 note.
  const unpriced = Math.round(data.reduce((sum, e) => sum + e.unpricedHours, 0) * 100) / 100;
  const footer = `\nUnpriced hours (no applicable labor category; no cost),${unpriced}\n${CURRENT_RATES_NOTE}\n`;

  return new NextResponse(csv + footer, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.csv"`,
    },
  });
}
