import { requirePageRole } from '@/lib/session';
import { getConnections, getAvailableConnectors } from '@/server/actions/integrations';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { IntegrationsClient } from './IntegrationsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Integrations' };

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  await requirePageRole('admin');

  const [connections, connectors, workspaceTimezone] = await Promise.all([
    getConnections(),
    getAvailableConnectors(),
    getWorkspaceTimezone(),
  ]);

  return (
    <IntegrationsClient
      initialConnections={connections}
      availableConnectors={connectors}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
