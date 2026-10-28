import { LoginForm } from './LoginForm';
import { safeNext } from '@/lib/safe-next';
import { workspaceAuthGate } from '@/components/auth/workspace-auth-gate';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in' };

export const dynamic = 'force-dynamic';

// UX-3 A4.8: `?next=` (from loginRedirect) is sanitized again here — a Promise in Next 16; an array takes its first value.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  return workspaceAuthGate('/login', () => <LoginForm next={next} />);
}
