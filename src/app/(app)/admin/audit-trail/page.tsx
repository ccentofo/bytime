import { getAuditSummary, getContractsForFilter, getUsersForFilter } from '@/server/actions/audit';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { AuditTrailClient } from './AuditTrailClient';
import { requirePageRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AuditTrailPage() {
  await requirePageRole('approver');

  const [summary, contractsList, usersList, workspaceTimezone] = await Promise.all([
    getAuditSummary(),
    getContractsForFilter(),
    getUsersForFilter(),
    getWorkspaceTimezone(),
  ]);

  return (
    <AuditTrailClient
      initialSummary={summary}
      contracts={contractsList}
      users={usersList}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
