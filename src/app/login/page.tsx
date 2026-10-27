import { LoginForm } from './LoginForm';
import { workspaceAuthGate } from '@/components/auth/workspace-auth-gate';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in' };

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  return workspaceAuthGate('/login', () => <LoginForm />);
}
