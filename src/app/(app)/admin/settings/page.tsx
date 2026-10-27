import { requirePageRole } from '@/lib/session';
import { getCurrentEffectiveConfig, getPendingConfigChange } from '@/server/actions/pay-period-config';
import { getWorkspaceTimezoneSetting, getWorkweekStartDaySetting } from '@/server/actions/workspace-settings';
import { SettingsClient } from './SettingsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Settings' };

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requirePageRole('admin');

  const [config, pendingChange, workspaceTimezone, workweekStartDay] = await Promise.all([
    getCurrentEffectiveConfig(),
    getPendingConfigChange(),
    getWorkspaceTimezoneSetting(),
    getWorkweekStartDaySetting(),
  ]);

  return <SettingsClient initialConfig={config} pendingChange={pendingChange} initialTimezone={workspaceTimezone} initialWorkweekStartDay={workweekStartDay} />;
}
