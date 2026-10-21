import { requirePageRole } from '@/lib/session';
import { getCurrentEffectiveConfig, getPendingConfigChange } from '@/server/actions/pay-period-config';
import { getWorkspaceTimezoneSetting } from '@/server/actions/workspace-settings';
import { SettingsClient } from './SettingsClient';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requirePageRole('admin');

  const [config, pendingChange, workspaceTimezone] = await Promise.all([
    getCurrentEffectiveConfig(),
    getPendingConfigChange(),
    getWorkspaceTimezoneSetting(),
  ]);

  return <SettingsClient initialConfig={config} pendingChange={pendingChange} initialTimezone={workspaceTimezone} />;
}
