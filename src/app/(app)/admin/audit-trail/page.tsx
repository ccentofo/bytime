import { getAuditSummary, getContractsForFilter, getUsersForFilter } from '@/server/actions/audit';
import { AuditTrailClient } from './AuditTrailClient';
import { requirePageRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AuditTrailPage() {
  await requirePageRole('approver');

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
