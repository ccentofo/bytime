import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { AppShellWrapper } from './AppShellWrapper';

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

  return (
    <AppShellWrapper user={user}>
      {children}
    </AppShellWrapper>
  );
}
