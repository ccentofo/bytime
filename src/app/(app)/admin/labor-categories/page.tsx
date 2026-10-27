import { getAllLaborCategories, getUserLaborCategoryAssignments, getAssignableLaborCategories, getUnpricedHoursReport, getOverlappingAssignmentsReport } from '@/server/actions/labor-categories';
import { CostBasisReports } from './CostBasisReports';
import { getContracts } from '@/server/actions/contracts';
import { getUsers } from '@/server/actions/users';
import { LaborCategoriesClient } from './LaborCategoriesClient';
import { requirePageRole } from '@/lib/session';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';

export const dynamic = 'force-dynamic';

export default async function LaborCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string; contractId?: string; clinId?: string; slinId?: string; startDate?: string; endDate?: string }>;
}) {
  await requirePageRole('admin');
  const params = await searchParams;
  // certified-outputs C3: the "X hours unpriced" links open the Unpriced hours report scoped to their total.
  const scope = { contractId: params.contractId, clinId: params.clinId, slinId: params.slinId, startDate: params.startDate, endDate: params.endDate };

  const [laborCats, assignments, contracts, users, assignableLcats, unpriced, overlaps, today] = await Promise.all([
    getAllLaborCategories(),
    getUserLaborCategoryAssignments(),
    getContracts(),
    getUsers(),
    getAssignableLaborCategories(),
    getUnpricedHoursReport(scope),
    getOverlappingAssignmentsReport(),
    getWorkspaceToday(), // dated rates D2: "today" for the current-rate display — the workspace's, from the server
  ]);

  return (
    <>
    <LaborCategoriesClient
      initialLaborCategories={laborCats}
      initialAssignments={assignments}
      contracts={contracts}
      users={users}
      assignableLcats={assignableLcats}
      today={today}
    />
    <CostBasisReports
      report={params.report === 'overlaps' ? 'overlaps' : 'unpriced'}
      unpriced={unpriced}
      overlaps={overlaps}
      scoped={Object.values(scope).some(Boolean)}
    />
    </>
  );
}
