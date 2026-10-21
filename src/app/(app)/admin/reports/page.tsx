import { requirePageRole } from '@/lib/session';
import { getReportFilterOptions } from '@/server/actions/reports';
import { ReportsClient } from './ReportsClient';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  await requirePageRole('approver');

  const filterOptions = await getReportFilterOptions();

  return <ReportsClient filterOptions={filterOptions} />;
}
