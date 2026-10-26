import { requirePageRole } from '@/lib/session';
import { getScopedPeriods, getMyScopeInfo } from '@/server/actions/periods';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { ApprovalsClient } from './ApprovalsClient';
import { getApprovalNotices } from '@/server/actions/users';
import { ApprovalNotices } from '@/components/approvals/ApprovalNotices';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const user = await requirePageRole('approver');

  // Parallel fetch: periods + scope info (scope info is independent of periods)
  const [periods, scopeInfo, workspaceTimezone, notices] = await Promise.all([
    getScopedPeriods(),
    getMyScopeInfo(),
    getWorkspaceTimezone(),
    user.role === 'admin' ? getApprovalNotices() : Promise.resolve(null),
  ]);

  return (
    <>
    {notices && <ApprovalNotices adminId={user.id} notices={notices} show={['backOn']} />}
    <ApprovalsClient
      initialPeriods={periods}
      currentUserId={user.id}
      userRole={user.role}
      scopeInfo={scopeInfo}
      workspaceTimezone={workspaceTimezone}
    />
    </>
  );
}
