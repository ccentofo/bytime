import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getCurrentEffectiveConfig, getPendingConfigChange } from '@/server/actions/pay-period-config';
import { SettingsClient } from './SettingsClient';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

  const [config, pendingChange] = await Promise.all([
    getCurrentEffectiveConfig(),
    getPendingConfigChange(),
  ]);

  return <SettingsClient initialConfig={config} pendingChange={pendingChange} />;
}
