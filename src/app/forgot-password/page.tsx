import { ForgotPasswordForm } from './ForgotPasswordForm';
import { workspaceAuthGate } from '@/components/auth/workspace-auth-gate';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Reset your password' };

export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage() {
  return workspaceAuthGate('/forgot-password', () => <ForgotPasswordForm />);
}
