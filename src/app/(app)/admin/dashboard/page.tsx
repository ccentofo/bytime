import { getContractSummaries } from '@/server/actions/dashboard';
import { DashboardClient } from './DashboardClient';
import { requirePageRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  await requirePageRole('admin');

  const summaries = await getContractSummaries();

  return <DashboardClient initialSummaries={summaries} />;
}
