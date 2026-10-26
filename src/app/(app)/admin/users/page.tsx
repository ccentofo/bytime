import { requirePageRole } from '@/lib/session';
import { getApprovalNotices, getUsers } from '@/server/actions/users';
import { ApprovalNotices } from '@/components/approvals/ApprovalNotices';
import { UsersClient } from './UsersClient';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const user = await requirePageRole('admin');

  const [users, notices] = await Promise.all([getUsers(), getApprovalNotices()]);
  return (
    <>
      <ApprovalNotices adminId={user.id} notices={notices} show={['recommend']} />
      <UsersClient initialUsers={users} currentUserId={user.id} />
    </>
  );
}
