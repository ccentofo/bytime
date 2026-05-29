'use client';

import { useState, useTransition } from 'react';
import {
  Container,
  Title,
  Text,
  Paper,
  Group,
  Badge,
  Button,
  Stack,
  Table,
  Select,
  Tabs,
  Alert,
  ThemeIcon,
  Anchor,
  Divider,
  Loader,
} from '@mantine/core';
import {
  IconPlugConnected,
  IconUsers,
  IconFileText,
  IconList,
  IconRefresh,
  IconPlayerPlay,
  IconArrowLeft,
  IconCheck,
  IconX,
  IconHistory,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  fetchQBOEmployeesForMapping,
  fetchQBOCustomersForMapping,
  fetchQBOServiceItemsForMapping,
  fetchQBOVendorsForMapping,
  triggerQBOSync,
} from '@/server/actions/qbo';
import { saveMapping, disconnectIntegration, toggleAutoSync } from '@/server/actions/integrations';

dayjs.extend(relativeTime);

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

interface Mapping {
  id: string;
  connectionId: string;
  entityType: string;
  bytimeEntityId: string;
  bytimeEntityName: string | null;
  externalEntityId: string;
  externalEntityName: string | null;
  metadata: string | null;
}

interface SyncLog {
  id: string;
  syncType: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  triggerType: string;
  recordsPushed: number;
  recordsFailed: number;
  recordsSkipped: number;
  status: string;
  errorSummary: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

interface Props {
  connection: Connection;
  mappings: Mapping[];
  syncLogs: SyncLog[];
  bytimeEmployees: Array<{ id: string; fullName: string; email: string }>;
  bytimeContracts: Array<{ id: string; contractNumber: string; name: string }>;
  bytimeClins: Array<{ id: string; clinNumber: string; description: string | null; contractId: string }>;
  currentUserId: string;
}

const STATUS_COLORS: Record<string, string> = {
  success: 'green',
  partial: 'yellow',
  failed: 'red',
  running: 'blue',
  pending: 'gray',
};

export function QBOConfigClient({
  connection,
  mappings: initialMappings,
  syncLogs: initialSyncLogs,
  bytimeEmployees,
  bytimeContracts,
  bytimeClins,
  currentUserId,
}: Props) {
  const [mappings, setMappings] = useState(initialMappings);
  const [syncLogs] = useState(initialSyncLogs);
  const [isPending, startTransition] = useTransition();

  // QBO entities loaded on demand
  const [qboEmployees, setQboEmployees] = useState<Array<{ id: string; name: string; email?: string }>>([]);
  const [qboVendors, setQboVendors] = useState<Array<{ id: string; name: string; email?: string }>>([]);
  const [qboCustomers, setQboCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [qboItems, setQboItems] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingQBO, setLoadingQBO] = useState(false);

  async function loadQBOEntities() {
    setLoadingQBO(true);
    try {
      const [employees, vendors, customers, items] = await Promise.all([
        fetchQBOEmployeesForMapping(connection.id),
        fetchQBOVendorsForMapping(connection.id),
        fetchQBOCustomersForMapping(connection.id),
        fetchQBOServiceItemsForMapping(connection.id),
      ]);
      setQboEmployees(employees);
      setQboVendors(vendors);
      setQboCustomers(customers);
      setQboItems(items);
      notifications.show({ title: 'QBO data loaded', message: `${employees.length} employees, ${vendors.length} vendors, ${customers.length} customers, ${items.length} service items`, color: 'green' });
    } catch (error) {
      notifications.show({ title: 'Failed to load QBO data', message: String(error), color: 'red' });
    } finally {
      setLoadingQBO(false);
    }
  }

  async function handleSaveMapping(entityType: string, bytimeId: string, bytimeName: string, externalId: string, externalName: string) {
    try {
      await saveMapping({
        connectionId: connection.id,
        entityType,
        bytimeEntityId: bytimeId,
        bytimeEntityName: bytimeName,
        externalEntityId: externalId,
        externalEntityName: externalName,
      });

      // Update local state
      setMappings((prev) => {
        const existing = prev.findIndex(
          (m) => m.entityType === entityType && m.bytimeEntityId === bytimeId
        );
        const newMapping: Mapping = {
          id: 'temp-' + Date.now(),
          connectionId: connection.id,
          entityType,
          bytimeEntityId: bytimeId,
          bytimeEntityName: bytimeName,
          externalEntityId: externalId,
          externalEntityName: externalName,
          metadata: null,
        };
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = newMapping;
          return updated;
        }
        return [...prev, newMapping];
      });

      notifications.show({ title: 'Mapping saved', message: `${bytimeName} → ${externalName}`, color: 'green' });
    } catch (error) {
      notifications.show({ title: 'Failed to save mapping', message: String(error), color: 'red' });
    }
  }

  async function handleSync() {
    // Sync last 2 months of approved data
    const periodStart = dayjs().subtract(2, 'month').startOf('month').toDate();
    const periodEnd = dayjs().endOf('month').toDate();

    startTransition(async () => {
      try {
        const result = await triggerQBOSync({
          connectionId: connection.id,
          periodStart,
          periodEnd,
          triggeredBy: currentUserId,
        });
        notifications.show({
          title: 'Sync complete',
          message: `Pushed: ${result.result.pushed}, Failed: ${result.result.failed}, Skipped: ${result.result.skipped}`,
          color: result.result.failed === 0 ? 'green' : 'yellow',
        });
      } catch (error) {
        notifications.show({ title: 'Sync failed', message: String(error), color: 'red' });
      }
    });
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect QuickBooks Online? This will remove all stored tokens. Mappings and sync logs will be preserved.')) return;
    try {
      await disconnectIntegration(connection.id);
      window.location.href = '/admin/integrations';
    } catch (error) {
      notifications.show({ title: 'Failed to disconnect', message: String(error), color: 'red' });
    }
  }

  function getMappingForEntity(entityType: string, bytimeId: string): Mapping | undefined {
    return mappings.find((m) => m.entityType === entityType && m.bytimeEntityId === bytimeId);
  }

  return (
    <Container size="lg" py="xl">
      {/* Header */}
      <Group mb="md">
        <Anchor href="/admin/integrations" size="sm">
          <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
          Back to Integrations
        </Anchor>
      </Group>

      <Group justify="space-between" align="flex-start" mb="xl">
        <div>
          <Group gap="sm" mb={4}>
            <ThemeIcon size="lg" color="green" variant="light" radius="md">
              <IconPlugConnected size={20} />
            </ThemeIcon>
            <Title order={2}>{connection.displayName}</Title>
          </Group>
          <Text c="dimmed" size="sm">
            {connection.externalCompanyName ?? 'QuickBooks Online'}
            {' • '}Connected {dayjs(connection.connectedAt).format('MMM D, YYYY')}
          </Text>
        </div>
        <Group>
          <Button
            variant="light"
            size="sm"
            leftSection={<IconRefresh size={14} />}
            onClick={loadQBOEntities}
            loading={loadingQBO}
          >
            Load QBO Data
          </Button>
          <Button
            variant="filled"
            size="sm"
            leftSection={<IconPlayerPlay size={14} />}
            onClick={handleSync}
            loading={isPending}
            disabled={mappings.filter((m) => m.entityType === 'employee' || m.entityType === 'vendor').length === 0}
          >
            Sync Now
          </Button>
          <Button
            variant="subtle"
            color="red"
            size="sm"
            onClick={handleDisconnect}
          >
            Disconnect
          </Button>
        </Group>
      </Group>

      {/* Status Bar */}
      <Paper withBorder p="md" radius="md" mb="xl">
        <Group justify="space-between">
          <Group gap="lg">
            <div>
              <Text size="xs" c="dimmed">Employee Mappings</Text>
              <Text fw={600}>{mappings.filter((m) => m.entityType === 'employee').length} / {bytimeEmployees.length}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">Contract Mappings</Text>
              <Text fw={600}>{mappings.filter((m) => m.entityType === 'contract').length} / {bytimeContracts.length}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">CLIN Mappings</Text>
              <Text fw={600}>{mappings.filter((m) => m.entityType === 'clin').length} / {bytimeClins.length}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">Last Sync</Text>
              <Text fw={600}>{connection.lastSyncAt ? dayjs(connection.lastSyncAt).fromNow() : 'Never'}</Text>
            </div>
          </Group>
          {connection.lastSyncStatus && (
            <Badge color={STATUS_COLORS[connection.lastSyncStatus] ?? 'gray'} variant="light">
              {connection.lastSyncStatus}
            </Badge>
          )}
        </Group>
      </Paper>

      {qboEmployees.length === 0 && (
        <Alert color="blue" variant="light" mb="xl">
          Click <strong>&quot;Load QBO Data&quot;</strong> to fetch employees, customers, and service items from QuickBooks Online for mapping.
        </Alert>
      )}

      {/* Tabs: Employees, Vendors, Contracts, CLINs, Sync History */}
      <Tabs defaultValue="employees">
        <Tabs.List mb="md">
          <Tabs.Tab value="employees" leftSection={<IconUsers size={16} />}>
            Employees ({mappings.filter((m) => m.entityType === 'employee').length})
          </Tabs.Tab>
          <Tabs.Tab value="vendors" leftSection={<IconUsers size={16} />}>
            Vendors ({mappings.filter((m) => m.entityType === 'vendor').length})
          </Tabs.Tab>
          <Tabs.Tab value="contracts" leftSection={<IconFileText size={16} />}>
            Contracts ({mappings.filter((m) => m.entityType === 'contract').length})
          </Tabs.Tab>
          <Tabs.Tab value="clins" leftSection={<IconList size={16} />}>
            CLINs ({mappings.filter((m) => m.entityType === 'clin').length})
          </Tabs.Tab>
          <Tabs.Tab value="history" leftSection={<IconHistory size={16} />}>
            Sync History ({syncLogs.length})
          </Tabs.Tab>
        </Tabs.List>

        {/* Employee Mapping Tab */}
        <Tabs.Panel value="employees">
          <Text size="xs" c="dimmed" mb="sm">
            Map ByTime employees to QBO W-2 employees. For 1099 contractors, use the Vendors tab instead.
          </Text>
          <MappingTable
            entityType="employee"
            bytimeEntities={bytimeEmployees.map((e) => ({ id: e.id, name: e.fullName, detail: e.email }))}
            externalEntities={qboEmployees.map((e) => ({ value: e.id, label: `${e.name}${e.email ? ` (${e.email})` : ''}` }))}
            mappings={mappings}
            onSave={handleSaveMapping}
            emptyExternalMessage="Load QBO Data to see employees"
          />
        </Tabs.Panel>

        {/* Vendor Mapping Tab */}
        <Tabs.Panel value="vendors">
          <Text size="xs" c="dimmed" mb="sm">
            Map ByTime employees to QBO vendors for 1099 subcontractors. Time entries will be pushed as vendor TimeActivity records.
            A ByTime user should be mapped as either an Employee OR a Vendor — not both.
          </Text>
          <MappingTable
            entityType="vendor"
            bytimeEntities={bytimeEmployees.map((e) => ({ id: e.id, name: e.fullName, detail: e.email }))}
            externalEntities={qboVendors.map((v) => ({ value: v.id, label: `${v.name}${v.email ? ` (${v.email})` : ''}` }))}
            mappings={mappings}
            onSave={handleSaveMapping}
            emptyExternalMessage="Load QBO Data to see vendors"
          />
        </Tabs.Panel>

        {/* Contract Mapping Tab */}
        <Tabs.Panel value="contracts">
          <MappingTable
            entityType="contract"
            bytimeEntities={bytimeContracts.map((c) => ({ id: c.id, name: c.name, detail: c.contractNumber }))}
            externalEntities={qboCustomers.map((c) => ({ value: c.id, label: c.name }))}
            mappings={mappings}
            onSave={handleSaveMapping}
            emptyExternalMessage="Load QBO Data to see customers"
          />
        </Tabs.Panel>

        {/* CLIN Mapping Tab */}
        <Tabs.Panel value="clins">
          <MappingTable
            entityType="clin"
            bytimeEntities={bytimeClins.map((c) => ({ id: c.id, name: c.clinNumber, detail: c.description ?? '' }))}
            externalEntities={qboItems.map((i) => ({ value: i.id, label: i.name }))}
            mappings={mappings}
            onSave={handleSaveMapping}
            emptyExternalMessage="Load QBO Data to see service items"
          />
        </Tabs.Panel>

        {/* Sync History Tab */}
        <Tabs.Panel value="history">
          <Paper withBorder radius="md">
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Trigger</Table.Th>
                  <Table.Th>Pushed</Table.Th>
                  <Table.Th>Failed</Table.Th>
                  <Table.Th>Skipped</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {syncLogs.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={7}>
                      <Text c="dimmed" ta="center" py="md">No sync history yet</Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  syncLogs.map((log) => (
                    <Table.Tr key={log.id}>
                      <Table.Td>{dayjs(log.createdAt).format('MMM D, YYYY h:mm A')}</Table.Td>
                      <Table.Td>{log.syncType.replace(/_/g, ' ')}</Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light">{log.triggerType}</Badge>
                      </Table.Td>
                      <Table.Td>{log.recordsPushed}</Table.Td>
                      <Table.Td>{log.recordsFailed > 0 ? <Text c="red" size="sm" fw={600}>{log.recordsFailed}</Text> : '0'}</Table.Td>
                      <Table.Td>{log.recordsSkipped}</Table.Td>
                      <Table.Td>
                        <Badge color={STATUS_COLORS[log.status] ?? 'gray'} variant="light" size="sm">
                          {log.status}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Reusable Mapping Table Component
// ---------------------------------------------------------------------------

function MappingTable({
  entityType,
  bytimeEntities,
  externalEntities,
  mappings,
  onSave,
  emptyExternalMessage,
}: {
  entityType: string;
  bytimeEntities: Array<{ id: string; name: string; detail: string }>;
  externalEntities: Array<{ value: string; label: string }>;
  mappings: Mapping[];
  onSave: (entityType: string, bytimeId: string, bytimeName: string, externalId: string, externalName: string) => void;
  emptyExternalMessage: string;
}) {
  return (
    <Paper withBorder radius="md">
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>ByTime</Table.Th>
            <Table.Th>→</Table.Th>
            <Table.Th>QuickBooks Online</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {bytimeEntities.map((entity) => {
            const mapping = mappings.find(
              (m) => m.entityType === entityType && m.bytimeEntityId === entity.id
            );

            return (
              <Table.Tr key={entity.id}>
                <Table.Td>
                  <Text size="sm" fw={500}>{entity.name}</Text>
                  <Text size="xs" c="dimmed">{entity.detail}</Text>
                </Table.Td>
                <Table.Td>→</Table.Td>
                <Table.Td>
                  {externalEntities.length > 0 ? (
                    <Select
                      placeholder="Select..."
                      data={externalEntities}
                      value={mapping?.externalEntityId ?? null}
                      onChange={(value) => {
                        if (value) {
                          const ext = externalEntities.find((e) => e.value === value);
                          onSave(entityType, entity.id, entity.name, value, ext?.label ?? value);
                        }
                      }}
                      searchable
                      clearable
                      size="xs"
                    />
                  ) : (
                    <Text size="xs" c="dimmed">{emptyExternalMessage}</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  {mapping ? (
                    <Badge color="green" variant="light" size="sm" leftSection={<IconCheck size={10} />}>
                      Mapped
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="light" size="sm" leftSection={<IconX size={10} />}>
                      Unmapped
                    </Badge>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}
