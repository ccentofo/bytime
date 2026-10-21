import { getAllLaborCategories, getUserLaborCategoryAssignments, getAssignableLaborCategories } from '@/server/actions/labor-categories';
import { getContracts } from '@/server/actions/contracts';
import { getUsers } from '@/server/actions/users';
import { LaborCategoriesClient } from './LaborCategoriesClient';
import { requirePageRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function LaborCategoriesPage() {
  await requirePageRole('admin');

  const [laborCats, assignments, contracts, users, assignableLcats] = await Promise.all([
    getAllLaborCategories(),
    getUserLaborCategoryAssignments(),
    getContracts(),
    getUsers(),
    getAssignableLaborCategories(),
  ]);

  return (
    <LaborCategoriesClient
      initialLaborCategories={laborCats}
      initialAssignments={assignments}
      contracts={contracts}
      users={users}
      assignableLcats={assignableLcats}
    />
  );
}
