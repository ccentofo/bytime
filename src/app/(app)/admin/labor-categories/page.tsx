import { getAllLaborCategories, getUserLaborCategoryAssignments, getAssignableLaborCategories } from '@/server/actions/labor-categories';
import { getContracts } from '@/server/actions/contracts';
import { getUsers } from '@/server/actions/users';
import { LaborCategoriesClient } from './LaborCategoriesClient';
import { requirePageRole } from '@/lib/session';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Labor categories' };

export const dynamic = 'force-dynamic';

// UX-4b §4.4: the Unpriced hours and Overlapping assignments reports moved to Downloads › Unpriced hours
// (/admin/reports/unpriced; old ?report= links redirect there).
export default async function LaborCategoriesPage() {
  await requirePageRole('admin');

  const [laborCats, assignments, contracts, users, assignableLcats, today] = await Promise.all([
    getAllLaborCategories(),
    getUserLaborCategoryAssignments(),
    getContracts(),
    getUsers(),
    getAssignableLaborCategories(),
    getWorkspaceToday(), // dated rates D2: "today" for the current-rate display — the workspace's, from the server
  ]);

  return (
    <LaborCategoriesClient
      initialLaborCategories={laborCats}
      initialAssignments={assignments}
      contracts={contracts}
      users={users}
      assignableLcats={assignableLcats}
      today={today}
    />
  );
}
