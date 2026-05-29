'use client';

import {
  Container,
  Title,
  Text,
  SimpleGrid,
  Paper,
  Group,
  Badge,
  Button,
  Stack,
  ThemeIcon,
  Alert,
  Divider,
} from '@mantine/core';
import {
  IconPlug,
  IconPlugConnected,
  IconRefresh,
  IconCash,
  IconFileExport,
  IconCalculator,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);
import type { ConnectorMetadata } from '@/lib/integrations/types';

interface Connection {
  id: string;
  provider: string;
  displayName: string;
  externalCompanyName: string | null;
  isActive: boolean;
  autoSyncOnApproval: boolean;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  connectedAt: Date;
}

interface Props {
  initialConnections: Connection[];
  availableConnectors: ConnectorMetadata[];
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  accounting: <IconCalculator size={28} />,
  payroll: <IconCash size={28} />,
  export: <IconFileExport size={28} />,
};

const CATEGORY_LABELS: Record<string, string> = {
  accounting: 'Accounting',
  payroll: 'Payroll',
  export: 'Data Export',
};

const STATUS_COLORS: Record<string, string> = {
  success: 'green',
  partial: 'yellow',
  failed: 'red',
  running: 'blue',
  pending: 'gray',
};

export function IntegrationsClient({ initialConnections, availableConnectors }: Props) {
  const activeConnections = initialConnections.filter((c) => c.isActive);

  // Group connectors by category
  const categories = ['accounting', 'payroll', 'export'];

  return (
    <Container size="lg" py="xl">
      <Group justify="space-between" align="flex-start" mb="xl">
        <div>
          <Group gap="sm" mb={4}>
            <ThemeIcon size="lg" color="indigo" variant="light" radius="md">
              <IconPlug size={20} />
            </ThemeIcon>
            <Title order={2}>Integrations</Title>
          </Group>
          <Text c="dimmed" size="sm">
            Connect ByTime to your accounting and payroll systems.
          </Text>
        </div>
      </Group>

      {/* Active Connections */}
      {activeConnections.length > 0 && (
        <>
          <Title order={4} mb="sm">Active Connections</Title>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md" mb="xl">
            {activeConnections.map((conn) => (
              <Paper key={conn.id} withBorder p="md" radius="md">
                <Group justify="space-between" mb="sm">
                  <Group gap="xs">
                    <IconPlugConnected size={18} color="var(--mantine-color-green-6)" />
                    <Text fw={600} size="sm">{conn.displayName}</Text>
                  </Group>
                  <Badge color="green" variant="light" size="sm">Connected</Badge>
                </Group>
                {conn.externalCompanyName && (
                  <Text size="xs" c="dimmed" mb="xs">{conn.externalCompanyName}</Text>
                )}
                <Group gap="xs" mb="sm">
                  {conn.autoSyncOnApproval && (
                    <Badge size="xs" variant="light" color="blue">Auto-sync</Badge>
                  )}
                  {conn.lastSyncStatus && (
                    <Badge size="xs" variant="light" color={STATUS_COLORS[conn.lastSyncStatus] ?? 'gray'}>
                      Last sync: {conn.lastSyncStatus}
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  Connected {dayjs(conn.connectedAt).format('MMM D, YYYY')}
                  {conn.lastSyncAt && ` • Last sync ${dayjs(conn.lastSyncAt).fromNow()}`}
                </Text>
                {conn.provider === 'quickbooks_online' && (
                  <Button
                    component="a"
                    href={`/admin/integrations/quickbooks?connectionId=${conn.id}`}
                    size="xs"
                    variant="subtle"
                    mt="xs"
                    fullWidth
                  >
                    Configure →
                  </Button>
                )}
                {conn.provider === 'gusto' && (
                  <Button
                    component="a"
                    href={`/admin/integrations/gusto?connectionId=${conn.id}`}
                    size="xs"
                    variant="subtle"
                    mt="xs"
                    fullWidth
                  >
                    Configure →
                  </Button>
                )}
              </Paper>
            ))}
          </SimpleGrid>
          <Divider mb="xl" />
        </>
      )}

      {/* Available Connectors by Category */}
      {categories.map((category) => {
        const categoryConnectors = availableConnectors.filter((c) => c.category === category);
        if (categoryConnectors.length === 0) return null;

        return (
          <div key={category}>
            <Group gap="sm" mb="sm">
              <ThemeIcon size="sm" variant="light" color="gray">
                {CATEGORY_ICONS[category]}
              </ThemeIcon>
              <Title order={4}>{CATEGORY_LABELS[category]}</Title>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md" mb="xl">
              {categoryConnectors.map((connector) => {
                const isConnected = activeConnections.some((c) => c.provider === connector.id);
                return (
                  <Paper key={connector.id} withBorder p="md" radius="md">
                    <Group justify="space-between" mb="sm">
                      <Text fw={600} size="sm">{connector.name}</Text>
                      {isConnected ? (
                        <Badge color="green" variant="light" size="sm">Connected</Badge>
                      ) : (
                        <Badge color="gray" variant="light" size="sm">Available</Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed" mb="md">{connector.description}</Text>
                    <Group gap="xs" mb="sm">
                      {connector.capabilities.map((cap) => (
                        <Badge key={cap} size="xs" variant="outline">
                          {cap.replace(/_/g, ' ')}
                        </Badge>
                      ))}
                    </Group>
                    {!isConnected && connector.id === 'quickbooks_online' && (
                      <Button
                        component="a"
                        href={`/api/integrations/qbo-connect`}
                        size="sm"
                        variant="light"
                        fullWidth
                      >
                        Connect to QuickBooks
                      </Button>
                    )}
                    {!isConnected && connector.id === 'csv_export' && (
                      <Button
                        component="a"
                        href="/admin/integrations/payroll-export"
                        size="sm"
                        variant="light"
                        fullWidth
                      >
                        Configure Export
                      </Button>
                    )}
                    {!isConnected && connector.id === 'gusto' && (
                      <Button
                        component="a"
                        href="/api/integrations/gusto-connect"
                        size="sm"
                        variant="light"
                        fullWidth
                      >
                        Connect to Gusto
                      </Button>
                    )}
                    {!isConnected && connector.id !== 'quickbooks_online' && connector.id !== 'csv_export' && connector.id !== 'gusto' && (
                      <Button
                        size="sm"
                        variant="light"
                        fullWidth
                        disabled
                      >
                        {connector.authType === 'oauth2' ? 'Connect' : 'Configure'}
                      </Button>
                    )}
                    {isConnected && connector.id === 'gusto' && (
                      <Button
                        component="a"
                        href={`/admin/integrations/gusto?connectionId=${activeConnections.find((c) => c.provider === connector.id)?.id}`}
                        size="sm"
                        variant="filled"
                        fullWidth
                      >
                        Configure Mappings
                      </Button>
                    )}
                    {isConnected && connector.id === 'quickbooks_online' && (
                      <Button
                        component="a"
                        href={`/admin/integrations/quickbooks?connectionId=${activeConnections.find((c) => c.provider === connector.id)?.id}`}
                        size="sm"
                        variant="filled"
                        fullWidth
                      >
                        Configure Mappings
                      </Button>
                    )}
                  </Paper>
                );
              })}
            </SimpleGrid>
          </div>
        );
      })}

      {availableConnectors.length === 0 && (
        <Alert color="blue" variant="light">
          <Text size="sm">
            No integration connectors are installed yet. Connectors will appear here as they are added to the system.
          </Text>
        </Alert>
      )}
    </Container>
  );
}
