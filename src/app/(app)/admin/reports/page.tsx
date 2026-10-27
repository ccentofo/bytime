import { requirePageRole } from '@/lib/session';
import { getReportFilterOptions } from '@/server/actions/reports';
import { ReportsClient } from './ReportsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Reports' };

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const user = await requirePageRole('approver');

  const filterOptions = await getReportFilterOptions();

  return <ReportsClient filterOptions={filterOptions} role={user.role} />;
}
