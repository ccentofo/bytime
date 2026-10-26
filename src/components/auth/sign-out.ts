import { signOut } from 'next-auth/react';
import { clearDesigneeNoticeDismissals } from '@/components/approvals/ApprovalNotices';

/**
 * Sign out and land on THIS workspace's /login. `signOut({ callbackUrl: '/login' })` let Auth.js resolve '/login'
 * against its base URL, so signing out on acme.localhost landed on the apex. Like sign-in (LoginForm, redirect: false),
 * Auth.js only clears the session here and the browser navigates to a RELATIVE path, which stays on the current host.
 */
export async function signOutToLogin(): Promise<void> {
  clearDesigneeNoticeDismissals();
  await signOut({ redirect: false });
  window.location.assign('/login');
}
