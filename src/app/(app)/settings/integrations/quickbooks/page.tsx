import { redirect } from 'next/navigation';
import { requirePageRole } from '@/lib/session';
import { getConnections, getMappings, getSyncLogs } from '@/server/actions/integrations';
import {
  getBytimeEmployeesForMapping,
  getBytimeContractsForMapping,
  getBytimeClinsForMapping,
} from '@/server/actions/qbo';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { QBOConfigClient } from './QBOConfigClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'QuickBooks' };

export const dynamic = 'force-dynamic';

export default async function QBOConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ connectionId?: string }>;
}) {
  await requirePageRole('admin');

  const { connectionId } = await searchParams;

  // Get all QBO connections
  const allConnections = await getConnections();
  const qboConnections = allConnections.filter(
    (c) => c.provider === 'quickbooks_online' && c.isActive
  );

  if (qboConnections.length === 0) {
    redirect('/settings/integrations');
  }

  // Use the specified connection or the first one
  const activeConnectionId = connectionId ?? qboConnections[0].id;
  const activeConnection = qboConnections.find((c) => c.id === activeConnectionId);

  if (!activeConnection) {
    redirect('/settings/integrations');
  }

  // Fetch data in parallel
  const [mappings, syncLogs, bytimeEmployees, bytimeContracts, bytimeClins, workspaceTimezone] = await Promise.all([
    getMappings(activeConnectionId),
    getSyncLogs(activeConnectionId),
    getBytimeEmployeesForMapping(),
    getBytimeContractsForMapping(),
    getBytimeClinsForMapping(),
    getWorkspaceTimezone(),
  ]);

  return (
    <QBOConfigClient
      connection={activeConnection}
      mappings={mappings}
      syncLogs={syncLogs}
      bytimeEmployees={bytimeEmployees}
      bytimeContracts={bytimeContracts}
      bytimeClins={bytimeClins}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
