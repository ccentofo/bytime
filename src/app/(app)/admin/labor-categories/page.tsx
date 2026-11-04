import { getAllLaborCategories, getLaborCategoryPeopleCounts, getUnpricedSummary } from '@/server/actions/labor-categories';
import { getContracts } from '@/server/actions/contracts';
import { LaborCategoriesClient } from './LaborCategoriesClient';
import { requirePageRole } from '@/lib/session';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Labor categories' };

export const dynamic = 'force-dynamic';

/**
 * Labor categories (feature-plan-ux-kit-contracts.md §4.2): only categories and their rates. Assigning people moved to
 * People → Assignments ("Labor categories" tab, §4.3); the Unpriced hours report moved to Downloads › Unpriced hours
 * (/admin/reports/unpriced; old ?report= links redirect there). Five loads.
 */
export default async function LaborCategoriesPage() {
  await requirePageRole('admin');

  const [laborCats, contracts, peopleCounts, unpriced, today] = await Promise.all([
    getAllLaborCategories(),
    getContracts(), // the Add modal's contract list
    getLaborCategoryPeopleCounts(),
    getUnpricedSummary(),
    getWorkspaceToday(), // dated rates D2: "today" for the current-rate display — the workspace's, from the server
  ]);

  return (
    <LaborCategoriesClient
      initialLaborCategories={laborCats}
      contracts={contracts}
      peopleCounts={peopleCounts}
      unpricedHours={unpriced.hours}
      today={today}
    />
  );
}
