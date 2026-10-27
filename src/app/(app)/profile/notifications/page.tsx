import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getNotificationPreferences } from '@/server/actions/notifications';
import { NotificationsClient } from './NotificationsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Notifications' };

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const prefs = await getNotificationPreferences();

  const role = (session.user as any).role ?? 'employee';
  return <NotificationsClient initialPrefs={prefs} userRole={role} />;
}
