import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getConnections, getMappings, getSyncLogs } from '@/server/actions/integrations';
import {
  getBytimeEmployeesForMapping,
  getBytimeContractsForMapping,
  getBytimeClinsForMapping,
} from '@/server/actions/qbo';
import { QBOConfigClient } from './QBOConfigClient';

export const dynamic = 'force-dynamic';

export default async function QBOConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ connectionId?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

  const { connectionId } = await searchParams;

  // Get all QBO connections
  const allConnections = await getConnections();
  const qboConnections = allConnections.filter(
    (c) => c.provider === 'quickbooks_online' && c.isActive
  );

  if (qboConnections.length === 0) {
    redirect('/admin/integrations');
  }

  // Use the specified connection or the first one
  const activeConnectionId = connectionId ?? qboConnections[0].id;
  const activeConnection = qboConnections.find((c) => c.id === activeConnectionId);

  if (!activeConnection) {
    redirect('/admin/integrations');
  }

  // Fetch data in parallel
  const [mappings, syncLogs, bytimeEmployees, bytimeContracts, bytimeClins] = await Promise.all([
    getMappings(activeConnectionId),
    getSyncLogs(activeConnectionId),
    getBytimeEmployeesForMapping(),
    getBytimeContractsForMapping(),
    getBytimeClinsForMapping(),
  ]);

  return (
    <QBOConfigClient
      connection={activeConnection}
      mappings={mappings}
      syncLogs={syncLogs}
      bytimeEmployees={bytimeEmployees}
      bytimeContracts={bytimeContracts}
      bytimeClins={bytimeClins}
      currentUserId={session.user.id!}
    />
  );
}
