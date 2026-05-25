import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getNotificationPreferences } from '@/server/actions/notifications';
import { NotificationsClient } from './NotificationsClient';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const userId = session.user.id!;
  const prefs = await getNotificationPreferences(userId);

  return <NotificationsClient userId={userId} initialPrefs={prefs} />;
}
