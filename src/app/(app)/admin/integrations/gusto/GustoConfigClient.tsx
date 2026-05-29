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
} from '@mantine/core';
import {
  IconCash,
  IconUsers,
  IconRefresh,
  IconPlayerPlay,
  IconArrowLeft,
  IconCheck,
  IconX,
  IconHistory,
  IconWand,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  fetchGustoEmployeesForMapping,
  triggerGustoSync,
} from '@/server/actions/gusto';
import { saveMapping, disconnectIntegration } from '@/server/actions/integrations';

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
  currentUserId: string;
}

const STATUS_COLORS: Record<string, string> = {
  success: 'green',
  partial: 'yellow',
  failed: 'red',
  running: 'blue',
  pending: 'gray',
};

export function GustoConfigClient({
  connection,
  mappings: initialMappings,
  syncLogs: initialSyncLogs,
  bytimeEmployees,
  currentUserId,
}: Props) {
  const [mappings, setMappings] = useState(initialMappings);
  const [syncLogs] = useState(initialSyncLogs);
  const [isPending, startTransition] = useTransition();

  const [gustoEmployees, setGustoEmployees] = useState<Array<{ id: string; name: string; email?: string }>>([]);
  const [loadingGusto, setLoadingGusto] = useState(false);

  async function loadGustoEmployees() {
    setLoadingGusto(true);
    try {
      const employees = await fetchGustoEmployeesForMapping(connection.id);
      setGustoEmployees(employees);
      notifications.show({ title: 'Gusto data loaded', message: `${employees.length} employees fetched`, color: 'green' });
    } catch (error) {
      notifications.show({ title: 'Failed to load Gusto data', message: String(error), color: 'red' });
    } finally {
      setLoadingGusto(false);
    }
  }

  async function handleAutoMatch() {
    if (gustoEmployees.length === 0) {
      notifications.show({ title: 'Load Gusto data first', message: 'Click "Load Gusto Employees" before auto-matching.', color: 'yellow' });
      return;
    }

    let matched = 0;
    for (const btEmp of bytimeEmployees) {
      // Check if already mapped
      const existing = mappings.find((m) => m.entityType === 'employee' && m.bytimeEntityId === btEmp.id);
      if (existing) continue;

      // Try to match by email
      const gustoMatch = gustoEmployees.find(
        (ge) => ge.email && ge.email.toLowerCase() === btEmp.email.toLowerCase()
      );

      if (gustoMatch) {
        await handleSaveMapping('employee', btEmp.id, btEmp.fullName, gustoMatch.id, gustoMatch.name);
        matched++;
      }
    }

    notifications.show({
      title: 'Auto-match complete',
      message: `${matched} employees matched by email. Review and adjust any remaining unmapped employees.`,
      color: matched > 0 ? 'green' : 'yellow',
    });
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
    } catch (error) {
      notifications.show({ title: 'Failed to save mapping', message: String(error), color: 'red' });
    }
  }

  async function handleSync() {
    const periodStart = dayjs().subtract(2, 'month').startOf('month').toDate();
    const periodEnd = dayjs().endOf('month').toDate();

    startTransition(async () => {
      try {
        const result = await triggerGustoSync({
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
    if (!confirm('Disconnect Gusto? Tokens will be removed. Mappings and sync logs will be preserved.')) return;
    try {
      await disconnectIntegration(connection.id);
      window.location.href = '/admin/integrations';
    } catch (error) {
      notifications.show({ title: 'Failed to disconnect', message: String(error), color: 'red' });
    }
  }

  const employeeMappingCount = mappings.filter((m) => m.entityType === 'employee').length;

  return (
    <Container size="lg" py="xl">
      <Group mb="md">
        <Anchor href="/admin/integrations" size="sm">
          <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
          Back to Integrations
        </Anchor>
      </Group>

      <Group justify="space-between" align="flex-start" mb="xl">
        <div>
          <Group gap="sm" mb={4}>
            <ThemeIcon size="lg" color="teal" variant="light" radius="md">
              <IconCash size={20} />
            </ThemeIcon>
            <Title order={2}>{connection.displayName}</Title>
          </Group>
          <Text c="dimmed" size="sm">
            {connection.externalCompanyName ?? 'Gusto'}
            {' • '}Connected {dayjs(connection.connectedAt).format('MMM D, YYYY')}
          </Text>
        </div>
        <Group>
          <Button variant="light" size="sm" leftSection={<IconRefresh size={14} />} onClick={loadGustoEmployees} loading={loadingGusto}>
            Load Gusto Employees
          </Button>
          <Button variant="light" size="sm" color="grape" leftSection={<IconWand size={14} />} onClick={handleAutoMatch} disabled={gustoEmployees.length === 0}>
            Auto-Match by Email
          </Button>
          <Button variant="filled" size="sm" leftSection={<IconPlayerPlay size={14} />} onClick={handleSync} loading={isPending} disabled={employeeMappingCount === 0}>
            Sync Now
          </Button>
          <Button variant="subtle" color="red" size="sm" onClick={handleDisconnect}>
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
              <Text fw={600}>{employeeMappingCount} / {bytimeEmployees.length}</Text>
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

      {gustoEmployees.length === 0 && (
        <Alert color="blue" variant="light" mb="xl">
          Click <strong>&quot;Load Gusto Employees&quot;</strong> to fetch employees from Gusto. Then use <strong>&quot;Auto-Match by Email&quot;</strong> for automatic mapping.
        </Alert>
      )}

      <Tabs defaultValue="employees">
        <Tabs.List mb="md">
          <Tabs.Tab value="employees" leftSection={<IconUsers size={16} />}>
            Employee Mapping ({employeeMappingCount})
          </Tabs.Tab>
          <Tabs.Tab value="history" leftSection={<IconHistory size={16} />}>
            Sync History ({syncLogs.length})
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="employees">
          <Paper withBorder radius="md">
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>ByTime Employee</Table.Th>
                  <Table.Th>→</Table.Th>
                  <Table.Th>Gusto Employee</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {bytimeEmployees.map((emp) => {
                  const mapping = mappings.find(
                    (m) => m.entityType === 'employee' && m.bytimeEntityId === emp.id
                  );
                  return (
                    <Table.Tr key={emp.id}>
                      <Table.Td>
                        <Text size="sm" fw={500}>{emp.fullName}</Text>
                        <Text size="xs" c="dimmed">{emp.email}</Text>
                      </Table.Td>
                      <Table.Td>→</Table.Td>
                      <Table.Td>
                        {gustoEmployees.length > 0 ? (
                          <Select
                            placeholder="Select Gusto employee..."
                            data={gustoEmployees.map((ge) => ({
                              value: ge.id,
                              label: `${ge.name}${ge.email ? ` (${ge.email})` : ''}`,
                            }))}
                            value={mapping?.externalEntityId ?? null}
                            onChange={(value) => {
                              if (value) {
                                const ge = gustoEmployees.find((e) => e.id === value);
                                handleSaveMapping('employee', emp.id, emp.fullName, value, ge?.name ?? value);
                              }
                            }}
                            searchable
                            clearable
                            size="xs"
                          />
                        ) : (
                          <Text size="xs" c="dimmed">Load Gusto Employees first</Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {mapping ? (
                          <Badge color="green" variant="light" size="sm" leftSection={<IconCheck size={10} />}>Mapped</Badge>
                        ) : (
                          <Badge color="gray" variant="light" size="sm" leftSection={<IconX size={10} />}>Unmapped</Badge>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="history">
          <Paper withBorder radius="md">
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
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
                    <Table.Td colSpan={6}>
                      <Text c="dimmed" ta="center" py="md">No sync history yet</Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  syncLogs.map((log) => (
                    <Table.Tr key={log.id}>
                      <Table.Td>{dayjs(log.createdAt).format('MMM D, YYYY h:mm A')}</Table.Td>
                      <Table.Td><Badge size="xs" variant="light">{log.triggerType}</Badge></Table.Td>
                      <Table.Td>{log.recordsPushed}</Table.Td>
                      <Table.Td>{log.recordsFailed > 0 ? <Text c="red" size="sm" fw={600}>{log.recordsFailed}</Text> : '0'}</Table.Td>
                      <Table.Td>{log.recordsSkipped}</Table.Td>
                      <Table.Td>
                        <Badge color={STATUS_COLORS[log.status] ?? 'gray'} variant="light" size="sm">{log.status}</Badge>
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
