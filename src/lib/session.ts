import { auth } from '@/auth';

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
};

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user) return null;

  return {
    id: session.user.id as string,
    email: session.user.email as string,
    fullName: (session.user as any).fullName as string,
    role: (session.user as any).role as 'admin' | 'supervisor' | 'employee',
  };
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error('Unauthorized: No active session');
  }
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== 'admin' && user.role !== 'supervisor') {
    throw new Error('Forbidden: Admin or Supervisor role required');
  }
  return user;
}
