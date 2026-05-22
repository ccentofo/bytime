import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getAllPeriods } from '@/server/actions/periods';
import { ApprovalsClient } from './ApprovalsClient';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const periods = await getAllPeriods();
  return <ApprovalsClient initialPeriods={periods} currentUserId={session.user.id!} />;
}
