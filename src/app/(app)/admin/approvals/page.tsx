import { requirePageRole } from '@/lib/session';
import { getScopedPeriods, getMyScopeInfo } from '@/server/actions/periods';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { ApprovalsClient } from './ApprovalsClient';
import { getApprovalNotices } from '@/server/actions/users';
import { ApprovalNotices } from '@/components/approvals/ApprovalNotices';
import { validateUUID } from '@/lib/validation';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Approvals' };

export const dynamic = 'force-dynamic';

/** `?review={periodId}` (feature-plan-ux-approvals-payroll.md §3.1.7): the first value, a UUID, else ignored. */
function reviewIdFrom(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  try { return v ? validateUUID(v, 'Timesheet') : null; } catch { return null; }
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ review?: string | string[] }> }) {
  const user = await requirePageRole('approver');
  const initialReviewId = reviewIdFrom((await searchParams).review);

  // Parallel fetch: periods + scope info (scope info is independent of periods)
  const [periods, scopeInfo, workspaceTimezone, notices] = await Promise.all([
    getScopedPeriods(),
    getMyScopeInfo(),
    getWorkspaceTimezone(),
    user.role === 'admin' ? getApprovalNotices() : Promise.resolve(null),
  ]);

  return (
    <ApprovalsClient
      initialPeriods={periods}
      currentUserId={user.id}
      userRole={user.role}
      scopeInfo={scopeInfo}
      workspaceTimezone={workspaceTimezone}
      initialReviewId={initialReviewId}
      notices={notices ? <ApprovalNotices adminId={user.id} notices={notices} show={['backOn']} /> : null}
    />
  );
}
