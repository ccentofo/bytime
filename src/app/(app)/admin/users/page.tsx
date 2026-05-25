import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getUsers } from '@/server/actions/users';
import { UsersClient } from './UsersClient';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const users = await getUsers();
  return <UsersClient initialUsers={users} currentUserId={session.user.id!} />;
}
