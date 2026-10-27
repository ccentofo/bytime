import { requirePageRole } from '@/lib/session';
import { getWorkspaceTimezoneSetting, getWorkweekStartDaySetting } from '@/server/actions/workspace-settings';
import { WorkspaceSettingsClient } from './WorkspaceSettingsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Workspace' };

export const dynamic = 'force-dynamic';

export default async function WorkspaceSettingsPage() {
  await requirePageRole('admin');

  const [workspaceTimezone, workweekStartDay] = await Promise.all([
    getWorkspaceTimezoneSetting(),
    getWorkweekStartDaySetting(),
  ]);

  return <WorkspaceSettingsClient initialTimezone={workspaceTimezone} initialWorkweekStartDay={workweekStartDay} />;
}
