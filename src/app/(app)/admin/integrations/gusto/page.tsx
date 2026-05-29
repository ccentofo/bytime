import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getConnections, getMappings, getSyncLogs } from '@/server/actions/integrations';
import { getBytimeEmployeesForGustoMapping } from '@/server/actions/gusto';
import { GustoConfigClient } from './GustoConfigClient';

export const dynamic = 'force-dynamic';

export default async function GustoConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ connectionId?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

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

  const [mappings, syncLogs, bytimeEmployees] = await Promise.all([
    getMappings(activeConnectionId),
    getSyncLogs(activeConnectionId),
    getBytimeEmployeesForGustoMapping(),
  ]);

  return (
    <GustoConfigClient
      connection={activeConnection}
      mappings={mappings}
      syncLogs={syncLogs}
      bytimeEmployees={bytimeEmployees}
      currentUserId={session.user.id!}
    />
  );
}
