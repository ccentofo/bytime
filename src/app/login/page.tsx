import { LoginForm } from './LoginForm';
import { workspaceAuthGate } from '@/components/auth/workspace-auth-gate';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  return workspaceAuthGate('/login', () => <LoginForm />);
}
