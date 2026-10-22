import { ForgotPasswordForm } from './ForgotPasswordForm';
import { workspaceAuthGate } from '@/components/auth/workspace-auth-gate';

export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage() {
  return workspaceAuthGate('/forgot-password', () => <ForgotPasswordForm />);
}
