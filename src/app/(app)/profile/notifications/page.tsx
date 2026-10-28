import { auth } from '@/auth';
import { loginRedirect } from '@/lib/session';
import { getNotificationPreferences } from '@/server/actions/notifications';
import { NotificationsClient } from './NotificationsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Notifications' };

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user) return loginRedirect();

  const prefs = await getNotificationPreferences();

  const role = (session.user as any).role ?? 'employee';
  return <NotificationsClient initialPrefs={prefs} userRole={role} />;
}
