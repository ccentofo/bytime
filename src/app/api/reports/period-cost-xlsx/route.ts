import { NextRequest, NextResponse } from 'next/server';
import { getPeriodCostByPeriod } from '@/server/actions/reports';
import { generatePeriodCostExcel } from '@/lib/reports/period-cost-excel';
import { noHours, noHoursMessage } from '@/lib/reports/empty-range';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';

/**
 * "Cost by pay period" (feature-plan-ux-kit-contracts.md §4.5, R3): the last n ∈ {3, 6, 12} completed pay periods.
 * The guarded action (admin only) runs inside the try; no hours in those periods → 422 with a message the Downloads
 * page shows in place (R4).
 */
const ALLOWED_N = new Set(['3', '6', '12']);

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const nParam = new URL(request.url).searchParams.get('n') ?? '6';
  if (!ALLOWED_N.has(nParam)) {
    return NextResponse.json({ error: 'Invalid n (expected 3, 6 or 12).' }, { status: 400 });
  }
  const n = Number(nParam);

  try {
    const report = await getPeriodCostByPeriod(n);
    if (noHours(report.rows, (r) => r.hours)) {
      const { start } = report.periods[0];
      const { end } = report.periods[report.periods.length - 1];
      return NextResponse.json({ error: noHoursMessage(start, end) }, { status: 422 });
    }
    const buffer = await generatePeriodCostExcel(report, n);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="cost-by-pay-period-last-${n}.xlsx"`,
      },
    });
  } catch (error) {
    return guardErrorResponse(error);
  }
}
