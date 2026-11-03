import { NextRequest, NextResponse } from 'next/server';
import { getUnpricedExportData } from '@/server/actions/labor-categories';
import { generateUnpricedExcel } from '@/lib/reports/unpriced-excel';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import { parseUnpricedFilters } from '@/lib/unpriced-filters';
import { periodLabel } from '@/lib/timesheet/labels';
import type { CalendarDate } from '@/lib/calendar-date';

/**
 * The Unpriced hours Excel download (feature-plan-ux-kit-contracts.md §4.4.8). Filters as on the page, but an invalid
 * value is a 400 here (a download link is built by us). Nothing to fix and no overlaps → 422 with a message the page
 * shows in place (never 404). The guarded action runs inside the try.
 */
const FILTER_KEYS = ['contractId', 'clinId', 'slinId', 'start', 'end', 'startDate', 'endDate', 'reason'] as const;
const ENTRY_LIMIT = 50_000;

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const params = new URL(request.url).searchParams;
  const raw = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined]));
  const filters = parseUnpricedFilters(raw);
  const accepted: Record<string, unknown> = {
    contractId: filters.contractId, clinId: filters.clinId, slinId: filters.slinId,
    start: filters.startDate, startDate: filters.startDate, end: filters.endDate, endDate: filters.endDate, reason: filters.reason,
  };
  if (FILTER_KEYS.some((k) => raw[k] !== undefined && raw[k] !== '' && accepted[k] !== raw[k])) {
    return NextResponse.json({ error: 'Invalid filter (expected UUID ids, YYYY-MM-DD dates and reason=conflict).' }, { status: 400 });
  }

  try {
    const data = await getUnpricedExportData(filters);
    if (data.groups.length === 0 && data.overlaps.length === 0) {
      return NextResponse.json({ error: 'There are no unpriced hours or overlapping assignments to download.' }, { status: 422 });
    }
    const range = filters.startDate && filters.endDate ? periodLabel(filters.startDate as CalendarDate, filters.endDate as CalendarDate) : 'All time';
    const buffer = await generateUnpricedExcel({ ...data, entryLimit: ENTRY_LIMIT, scope: `${range}${filters.reason ? ' · overlapping categories only' : ''}` });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="unpriced-hours.xlsx"',
      },
    });
  } catch (error) {
    return guardErrorResponse(error);
  }
}
