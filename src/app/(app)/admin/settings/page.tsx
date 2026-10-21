import { requirePageRole } from '@/lib/session';
import { getCurrentEffectiveConfig, getPendingConfigChange } from '@/server/actions/pay-period-config';
import { SettingsClient } from './SettingsClient';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requirePageRole('admin');

  const [config, pendingChange] = await Promise.all([
    getCurrentEffectiveConfig(),
    getPendingConfigChange(),
  ]);

  return <SettingsClient initialConfig={config} pendingChange={pendingChange} />;
}
