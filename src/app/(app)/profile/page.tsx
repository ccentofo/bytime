import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getPasswordInfo } from '@/server/actions/password';
import { getMFAStatus } from '@/server/actions/mfa';
import { ProfileClient } from './ProfileClient';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const userId = session.user.id!;
  const fullName = (session.user as any).fullName ?? session.user.name ?? '';
  const email = session.user.email ?? '';
  const role = (session.user as any).role ?? 'employee';

  const [passwordInfo, mfaStatus] = await Promise.all([
    getPasswordInfo(userId),
    getMFAStatus(),
  ]);

  return (
    <ProfileClient
      userId={userId}
      fullName={fullName}
      email={email}
      role={role}
      passwordInfo={passwordInfo}
      mfaStatus={mfaStatus}
    />
  );
}
