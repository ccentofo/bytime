import { getContractSummaries } from '@/server/actions/dashboard';
import { getApprovalNotices } from '@/server/actions/users';
import { ApprovalNotices } from '@/components/approvals/ApprovalNotices';
import { DashboardClient } from './DashboardClient';
import { requirePageRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await requirePageRole('admin');

  const [summaries, notices] = await Promise.all([getContractSummaries(), getApprovalNotices()]);

  return (
    <>
      {/* certified-outputs C2 (CO-D19): self-approval back on / designate an independent reviewer. */}
      <ApprovalNotices adminId={user.id} notices={notices} show={['backOn', 'recommend']} />
      <DashboardClient initialSummaries={summaries} />
    </>
  );
}
