import { NextRequest, NextResponse } from 'next/server';
import { getUnpricedExportData } from '@/server/actions/labor-categories';
import { generateUnpricedExcel } from '@/lib/reports/unpriced-excel';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import { UNPRICED_FILTER_KEYS, invalidUnpricedFilterKeys, parseUnpricedFilters, unpricedScopeLabel } from '@/lib/unpriced-filters';

/**
 * The Unpriced hours Excel download (feature-plan-ux-kit-contracts.md §4.4.8). Filters as on the page, but an invalid
 * value is a 400 here (a download link is built by us); a legacy key beside its preferred one is fine, `start`/`end`
 * win (UX-4B1-AUDIT L8). Nothing to fix and no overlaps → 422 with a message the page shows in place (never 404). The
 * guarded action runs inside the try and cleans the filters again itself.
 */
const ENTRY_LIMIT = 50_000;

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const params = new URL(request.url).searchParams;
  const raw = Object.fromEntries(UNPRICED_FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined]));
  if (invalidUnpricedFilterKeys(raw).length > 0) {
    return NextResponse.json({ error: 'Invalid filter (expected UUID ids, YYYY-MM-DD dates and reason=conflict).' }, { status: 400 });
  }
  const filters = parseUnpricedFilters(raw);

  try {
    const data = await getUnpricedExportData(filters as Record<string, string | undefined>);
    if (data.groups.length === 0 && data.overlaps.length === 0) {
      return NextResponse.json({ error: 'There are no unpriced hours or overlapping assignments to download.' }, { status: 422 });
    }
    const buffer = await generateUnpricedExcel({ ...data, entryLimit: ENTRY_LIMIT, scope: unpricedScopeLabel(filters, data.scope) });
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
