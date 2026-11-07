import { requirePageRole } from '@/lib/session';
import { getApprovalNotices, getUsersForAdminPage } from '@/server/actions/users';
import { getSeatUsage } from '@/server/internal/seats';
import { ApprovalNotices } from '@/components/approvals/ApprovalNotices';
import { UsersClient } from './UsersClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Users' };

export const dynamic = 'force-dynamic';

/** Users (feature-plan-ux-people-codes.md §5): the users with two-step, lock and approver, the notices, the seat line. */
export default async function UsersPage() {
  const user = await requirePageRole('admin');

  const [users, notices, seats] = await Promise.all([getUsersForAdminPage(), getApprovalNotices(), getSeatUsage()]);
  return (
    <>
      <ApprovalNotices adminId={user.id} notices={notices} show={['recommend']} />
      <UsersClient initialUsers={users} currentUserId={user.id} seats={{ active: seats.currentActive, limit: seats.limit }} />
    </>
  );
}
