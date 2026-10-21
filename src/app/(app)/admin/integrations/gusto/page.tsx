import { redirect } from 'next/navigation';
import { requirePageRole } from '@/lib/session';
import { getConnections, getMappings, getSyncLogs } from '@/server/actions/integrations';
import { getBytimeEmployeesForGustoMapping } from '@/server/actions/gusto';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { GustoConfigClient } from './GustoConfigClient';

export const dynamic = 'force-dynamic';

export default async function GustoConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ connectionId?: string }>;
}) {
  await requirePageRole('admin');

  const { connectionId } = await searchParams;

  const allConnections = await getConnections();
  const gustoConnections = allConnections.filter(
    (c) => c.provider === 'gusto' && c.isActive
  );

  if (gustoConnections.length === 0) {
    redirect('/admin/integrations');
  }

  const activeConnectionId = connectionId ?? gustoConnections[0].id;
  const activeConnection = gustoConnections.find((c) => c.id === activeConnectionId);

  if (!activeConnection) {
    redirect('/admin/integrations');
  }

  const [mappings, syncLogs, bytimeEmployees, workspaceTimezone] = await Promise.all([
    getMappings(activeConnectionId),
    getSyncLogs(activeConnectionId),
    getBytimeEmployeesForGustoMapping(),
    getWorkspaceTimezone(),
  ]);

  return (
    <GustoConfigClient
      connection={activeConnection}
      mappings={mappings}
      syncLogs={syncLogs}
      bytimeEmployees={bytimeEmployees}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
