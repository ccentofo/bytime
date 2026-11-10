import { requirePageRole } from '@/lib/session';
import { getApprovalNotices, getUsersForAdminPage } from '@/server/actions/users';
import { getSeatUsage } from '@/server/internal/seats';
import { getApprovalClinOptions } from '@/server/actions/assignments';
import { ApprovalNotices } from '@/components/approvals/ApprovalNotices';
import { UsersClient } from './UsersClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Users' };

export const dynamic = 'force-dynamic';

/** Users (feature-plan-ux-people-codes.md §5): the users with two-step, lock and approver, the notices, the seat line. */
export default async function UsersPage() {
  const user = await requirePageRole('admin');

  // feature-plan-approval-scope.md §4.2: the active CLINs for the "CLINs they approve" picker.
  const [users, notices, seats, approvalClins] = await Promise.all([getUsersForAdminPage(), getApprovalNotices(), getSeatUsage(), getApprovalClinOptions()]);
  return (
    <>
      <ApprovalNotices adminId={user.id} notices={notices} show={['recommend']} />
      <UsersClient initialUsers={users} currentUserId={user.id} seats={{ active: seats.currentActive, limit: seats.limit }} approvalClins={approvalClins} />
    </>
  );
}
