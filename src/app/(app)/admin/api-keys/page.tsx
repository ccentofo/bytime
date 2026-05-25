import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getApiKeys } from '@/server/actions/api-keys';
import { ApiKeysClient } from './ApiKeysClient';

export const dynamic = 'force-dynamic';

export default async function ApiKeysPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const keys = await getApiKeys();
  const userId = session.user.id!;

  return <ApiKeysClient initialKeys={keys} currentUserId={userId} />;
}
