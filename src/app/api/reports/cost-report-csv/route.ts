import { NextRequest, NextResponse } from 'next/server';
import { getDetailedCostReport } from '@/server/actions/reports';
import { generateCsv } from '@/lib/reports/csv-generator';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import { isCalendarDate } from '@/lib/calendar-date';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';
import { noHours, noHoursMessage } from '@/lib/reports/empty-range';

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

  // Generation is inside the try too (feature-plan-ux-page-fixes.md C15): a failure returns the JSON 500.
  try {
    // Dollar data — admin-only. getDetailedCostReport enforces this via requireAdmin().
    const data = await getDetailedCostReport(
      startDate,
      endDate,
      contractId ?? undefined
    );
    // R4 (feature-plan-ux-kit-contracts.md §4.5): no hours in range (cleared-only included) → 422, shown in place.
    if (noHours(data, (e) => e.totalHours)) {
      return NextResponse.json({ error: noHoursMessage(startDate, endDate) }, { status: 422 });
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
  } catch (error) {
    return guardErrorResponse(error);
  }
}
