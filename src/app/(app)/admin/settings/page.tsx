import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getPayPeriodConfig } from '@/server/actions/pay-period-config';
import { SettingsClient } from './SettingsClient';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

  const config = await getPayPeriodConfig();

  return <SettingsClient initialConfig={config} />;
}
