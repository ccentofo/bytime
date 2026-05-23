import { getAuditSummary, getContractsForFilter, getUsersForFilter } from '@/server/actions/audit';
import { AuditTrailClient } from './AuditTrailClient';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function AuditTrailPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const [summary, contractsList, usersList] = await Promise.all([
    getAuditSummary(),
    getContractsForFilter(),
    getUsersForFilter(),
  ]);

  return (
    <AuditTrailClient
      initialSummary={summary}
      contracts={contractsList}
      users={usersList}
    />
  );
}
