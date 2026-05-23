import { getAllLaborCategories, getUserLaborCategoryAssignments, getAssignableLaborCategories } from '@/server/actions/labor-categories';
import { getContracts } from '@/server/actions/contracts';
import { getUsers } from '@/server/actions/users';
import { LaborCategoriesClient } from './LaborCategoriesClient';

export default async function LaborCategoriesPage() {
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
