import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { MigrationClient } from './MigrationClient';

export const dynamic = 'force-dynamic';

export default async function MigrationPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

  return <MigrationClient />;
}
