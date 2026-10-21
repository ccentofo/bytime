import { requirePageRole } from '@/lib/session';
import { getScopedPeriods, getMyScopeInfo } from '@/server/actions/periods';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { ApprovalsClient } from './ApprovalsClient';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const user = await requirePageRole('approver');

  // Parallel fetch: periods + scope info (scope info is independent of periods)
  const [periods, scopeInfo, workspaceTimezone] = await Promise.all([
    getScopedPeriods(),
    getMyScopeInfo(),
    getWorkspaceTimezone(),
  ]);

  return (
    <ApprovalsClient
      initialPeriods={periods}
      currentUserId={user.id}
      userRole={user.role}
      scopeInfo={scopeInfo}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
