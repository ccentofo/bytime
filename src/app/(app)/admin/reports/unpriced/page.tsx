import { requirePageRole } from '@/lib/session';
import { getUnpricedReport } from '@/server/actions/labor-categories';
import { getContracts } from '@/server/actions/contracts';
import { parseUnpricedFilters } from '@/lib/unpriced-filters';
import { UnpricedClient } from './UnpricedClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Unpriced hours' };

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

/**
 * Downloads › Unpriced hours (feature-plan-ux-kit-contracts.md §4.4, R1, U1): hours with no labor-category rate,
 * grouped into things to fix. Filters come from the URL (start/end or the legacy startDate/endDate; invalid values
 * ignored; no dates = All time).
 */
export default async function UnpricedPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePageRole('admin');
  const params = await searchParams;
  const filters = parseUnpricedFilters(params);
  const [report, contracts] = await Promise.all([getUnpricedReport(params), getContracts()]);
  const period = typeof params.period === 'string' ? params.period : undefined;
  return (
    <UnpricedClient
      report={report}
      filters={filters}
      period={period}
      contracts={contracts.map((c) => ({ id: c.id, name: c.name, contractNumber: c.contractNumber }))}
    />
  );
}
