import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getReportFilterOptions } from '@/server/actions/reports';
import { ReportsClient } from './ReportsClient';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const filterOptions = await getReportFilterOptions();

  return <ReportsClient filterOptions={filterOptions} />;
}
