import { getContractSummaries } from '@/server/actions/dashboard';
import { DashboardClient } from './DashboardClient';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') {
    redirect('/timesheet');
  }

  const summaries = await getContractSummaries();

  return <DashboardClient initialSummaries={summaries} />;
}
