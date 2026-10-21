import { requirePageRole } from '@/lib/session';
import { getConnections, getAvailableConnectors } from '@/server/actions/integrations';
import { IntegrationsClient } from './IntegrationsClient';

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  await requirePageRole('admin');

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
