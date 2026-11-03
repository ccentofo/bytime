import { requirePageRole } from '@/lib/session';
import { getReportFilterOptions } from '@/server/actions/reports';
import { getPeriodOptions } from '@/server/actions/periods';
import { getUnpricedSummary } from '@/server/actions/labor-categories';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { ReportsClient } from './ReportsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Downloads' };

export const dynamic = 'force-dynamic';

/**
 * Downloads (feature-plan-ux-kit-contracts.md §4.5, R1): filter options, the pay periods (this one and 24 back), and —
 * for admins only — the unpriced totals. A supervisor's load never calls getUnpricedSummary (admin-only dollar data).
 */
export default async function ReportsPage() {
  const user = await requirePageRole('approver');
  const isAdmin = user.role === 'admin';
  const today = await getWorkspaceToday();

  const [filterOptions, periodOptions, unpriced] = await Promise.all([
    getReportFilterOptions(),
    getPeriodOptions(today, 24, 0),
    isAdmin ? getUnpricedSummary() : Promise.resolve(null),
  ]);

  return (
    <ReportsClient
      filterOptions={filterOptions}
      role={user.role}
      periodOptions={periodOptions}
      today={today}
      unpriced={unpriced}
    />
  );
}
