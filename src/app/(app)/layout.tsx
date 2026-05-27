import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { AppShellWrapper } from './AppShellWrapper';
import { getSetupStatusInternal } from '@/server/actions/setup';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  const user = {
    fullName: (session.user as any).fullName ?? session.user.name ?? '',
    email: session.user.email ?? '',
    role: (session.user as any).role ?? 'employee',
  };

  // Only check setup status for admin users
  let setupComplete = true;
  if (user.role === 'admin') {
    try {
      const status = await getSetupStatusInternal();
      setupComplete = status.isComplete;
    } catch {
      // If setup status check fails, don't block the app
      setupComplete = true;
    }
  }

  return (
    <AppShellWrapper user={user} setupComplete={setupComplete}>
      {children}
    </AppShellWrapper>
  );
}
