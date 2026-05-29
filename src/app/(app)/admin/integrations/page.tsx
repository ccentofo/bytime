import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getConnections, getAvailableConnectors } from '@/server/actions/integrations';
import { IntegrationsClient } from './IntegrationsClient';

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

  const [connections, connectors] = await Promise.all([
    getConnections(),
    getAvailableConnectors(),
  ]);

  return (
    <IntegrationsClient
      initialConnections={connections}
      availableConnectors={connectors}
    />
  );
}
