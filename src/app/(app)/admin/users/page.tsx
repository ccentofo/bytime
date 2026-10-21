import { requirePageRole } from '@/lib/session';
import { getUsers } from '@/server/actions/users';
import { UsersClient } from './UsersClient';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const user = await requirePageRole('admin');

  const users = await getUsers();
  return <UsersClient initialUsers={users} currentUserId={user.id} />;
}
