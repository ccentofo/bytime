import { NextRequest, NextResponse } from 'next/server';
import { getDetailedCostReport } from '@/server/actions/reports';
import { csvLines } from '@/lib/reports/csv-generator';
import { streamJoined } from '@/lib/http/stream-text';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import { isCalendarDate } from '@/lib/calendar-date';
import { CURRENT_CLASS_NOTE, CURRENT_RATES_NOTE } from '@/lib/cost-labels';
import { escapeCsvField } from '@/lib/csv/escape';
import { noHours, noHoursMessage } from '@/lib/reports/empty-range';

// feature-plan-excel-cost-report.md §6.3 (Q5): a UTF-8 byte-order mark so Excel opens the file as UTF-8 ("—" not "â€”"),
// as the workspace export does. Written as an escape so it's visible.
const BOM = '\uFEFF';

// feature-plan-large-report-responses.md §6.2 item 4: the platform default today, stated so a plan change can't shorten it.
export const maxDuration = 300;

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

    const lines = csvLines(data, [
      { key: 'employeeName', header: 'Employee' },
      { key: 'contractName', header: 'Contract' },
      { key: 'contractNumber', header: 'Contract Number' },
      { key: 'clinNumber', header: 'CLIN' },
      { key: 'slinNumber', header: 'SLIN' },
      { key: 'chargeCode', header: 'Charge Code' }, // feature-plan-excel-cost-report.md E1/E2
      { key: 'className', header: 'Class' },
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
    // feature-plan-excel-cost-report.md E3 (Q4): the Class note, escaped (it has a comma, so it comes out quoted).
    const footer = `\nUnpriced hours (no applicable labor category; no cost),${unpriced}\n${CURRENT_RATES_NOTE}\n${escapeCsvField(CURRENT_CLASS_NOTE)}\n`;

    // feature-plan-large-report-responses.md §6.2: streamed past Vercel's 4.5 MB buffered-response limit. Every line is
    // built above (inside the try, so a failure is still the JSON 500); the stream only slices them and never holds `data`.
    // The bytes equal BOM + lines.join('\n') + footer, exactly the old body.
    return new Response(streamJoined({ head: BOM, items: lines, separator: '\n', tail: footer }), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.csv"`,
      },
    });
  } catch (error) {
    return guardErrorResponse(error);
  }
}
