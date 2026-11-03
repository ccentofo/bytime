'use client';

import { useState, useTransition } from 'react';
import {
  Container,
  Title,
  Text,
  Paper,
  Group,
  Badge,
  Stack,
  Table,
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
import { runAction, type RunResult } from '@/lib/run-action';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  fetchGustoEmployeesForMapping,
  triggerGustoSync,
} from '@/server/actions/gusto';
import { saveMapping, deleteMapping, disconnectIntegration } from '@/server/actions/integrations';
import { useRouter } from 'next/navigation';
import { MappingSelect } from '../MappingSelect';
import { formatDateTime } from '@/lib/format';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { SYNC_STATUS_COLOR } from '@/lib/ui/status-colors';
import type { CalendarDate } from '@/lib/calendar-date';
import { WriteButton } from '@/components/shell/WorkspaceMode';

dayjs.extend(relativeTime);

/** A refusal with one of these codes will refuse every remaining save too — the auto-match loop stops (audit A7). */
const STOP_AUTO_MATCH_CODES = new Set(['unauthenticated', 'forbidden', 'read_only']);

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
  periodStart: CalendarDate | null;
  periodEnd: CalendarDate | null;
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
  workspaceTimezone: string;
}


export function GustoConfigClient({
  connection,
  mappings: initialMappings,
  syncLogs,
  bytimeEmployees,
  workspaceTimezone,
}: Props) {
  const [mappings, setMappings] = useState(initialMappings);
  // C13: sync history renders the prop; router.refresh() after a sync brings the new log (client state is kept).
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Employees whose mapping save or delete is in flight.
  const [busyRows, setBusyRows] = useState<ReadonlySet<string>>(new Set());
  const setBusy = (id: string, on: boolean) => setBusyRows((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const [gustoEmployees, setGustoEmployees] = useState<Array<{ id: string; name: string; email?: string }>>([]);
  const [loadingGusto, setLoadingGusto] = useState(false);
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function loadGustoEmployees() {
    setLoadingGusto(true);
    const result = await runAction(fetchGustoEmployeesForMapping(connection.id), { errorTitle: 'Failed to load Gusto data' });
    setLoadingGusto(false);
    if (!result.ok) return;
    const employees = result.data;
    setGustoEmployees(employees);
    notifications.show({ title: 'Gusto data loaded', message: `${employees.length} employees fetched`, color: 'success' });
  }

  async function handleAutoMatch() {
    if (gustoEmployees.length === 0) {
      notifications.show({ title: 'Load Gusto data first', message: 'Click "Load Gusto Employees" before auto-matching.', color: 'warning' });
      return;
    }

    // Launch-blockers audit A7: count only saves that succeeded, and stop at the first refusal that will refuse
    // every remaining save too (signed out, no longer an admin, workspace read-only).
    let matched = 0;
    let failed = 0;
    for (const btEmp of bytimeEmployees) {
      // Check if already mapped
      const existing = mappings.find((m) => m.entityType === 'employee' && m.bytimeEntityId === btEmp.id);
      if (existing) continue;

      // Try to match by email
      const gustoMatch = gustoEmployees.find(
        (ge) => ge.email && ge.email.toLowerCase() === btEmp.email.toLowerCase()
      );

      if (gustoMatch) {
        const saved = await handleSaveMapping('employee', btEmp.id, btEmp.fullName, gustoMatch.id, gustoMatch.name);
        if (saved.ok) {
          matched++;
        } else {
          failed++;
          if (STOP_AUTO_MATCH_CODES.has(saved.code)) break;
        }
      }
    }

    if (matched === 0 && failed > 0) return; // each failure already showed its error; nothing to celebrate
    notifications.show({
      title: 'Auto-match complete',
      message: `${matched} employees matched by email.${failed > 0 ? ` ${failed} could not be saved.` : ''} Review and adjust any remaining unmapped employees.`,
      color: matched > 0 && failed === 0 ? 'success' : 'warning',
    });
  }

  async function handleSaveMapping(entityType: string, bytimeId: string, bytimeName: string, externalId: string, externalName: string): Promise<RunResult<unknown>> {
    setBusy(bytimeId, true);
    const saved = await runAction(saveMapping({
        connectionId: connection.id,
        entityType,
        bytimeEntityId: bytimeId,
        bytimeEntityName: bytimeName,
        externalEntityId: externalId,
        externalEntityName: externalName,
    }), { errorTitle: 'Failed to save mapping' });
    setBusy(bytimeId, false);
    if (!saved.ok) return saved;

    setMappings((prev) => {
      const existing = prev.findIndex(
        (m) => m.entityType === entityType && m.bytimeEntityId === bytimeId
      );
      const newMapping: Mapping = {
        id: saved.data.id,
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
    return saved;
  }

  /** C13: clearing a mapped Select deletes the mapping (one that's already gone is dropped from the page too). */
  async function handleClearMapping(bytimeId: string, bytimeName: string) {
    const mapping = mappings.find((m) => m.entityType === 'employee' && m.bytimeEntityId === bytimeId);
    if (!mapping) return;
    setBusy(bytimeId, true);
    const result = await runAction(deleteMapping(mapping.id), { errorTitle: 'Couldn’t remove mapping' });
    setBusy(bytimeId, false);
    if (result.ok || result.error === 'That mapping no longer exists.') {
      setMappings((prev) => prev.filter((m) => m.id !== mapping.id));
    }
    if (result.ok) notifications.show({ title: 'Mapping removed', message: `${bytimeName} is no longer matched.`, color: 'success' });
  }

  async function handleSync() {
    // Default window (two months back through this month) is computed on the server in the
    // workspace's calendar, not from this browser's clock.
    startTransition(async () => {
      const outcome = await runAction(triggerGustoSync({
        connectionId: connection.id,
      }), { errorTitle: 'Sync failed' });
      router.refresh();
      if (!outcome.ok) return;
      const result = outcome.data;
      notifications.show({
        title: 'Sync complete',
        message: `Pushed: ${result.result.pushed}, Failed: ${result.result.failed}, Skipped: ${result.result.skipped}`,
        color: result.result.failed === 0 ? 'success' : 'warning',
      });
    });
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    const result = await runAction(disconnectIntegration(connection.id), { errorTitle: 'Failed to disconnect' });
    if (!result.ok) {
      setDisconnecting(false);
      setConfirmDisconnectOpen(false);
      return;
    }
    window.location.href = '/settings/integrations';
  }

  const employeeMappingCount = mappings.filter((m) => m.entityType === 'employee').length;

  return (
    <Container size="lg" py="xl">
      <Group mb="md">
        <Anchor href="/settings/integrations" size="sm">
          <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
          Back to Integrations
        </Anchor>
      </Group>

      <Group justify="space-between" align="flex-start" mb="xl">
        <div>
          <Group gap="sm" mb={4}>
            <ThemeIcon size="lg" color="signal" variant="light" radius="md">
              <IconCash size={20} />
            </ThemeIcon>
            <Title order={1} size="h2">{connection.displayName}</Title>
          </Group>
          <Text c="dimmed" size="sm">
            {connection.externalCompanyName ?? 'Gusto'}
            {' • '}Connected {formatDateTime(connection.connectedAt, workspaceTimezone)}
          </Text>
        </div>
        <Group>
          <WriteButton variant="light" size="sm" leftSection={<IconRefresh size={14} />} onClick={loadGustoEmployees} loading={loadingGusto}>
            Load Gusto Employees
          </WriteButton>
          <WriteButton variant="light" size="sm" color="signal" leftSection={<IconWand size={14} />} onClick={handleAutoMatch} disabled={gustoEmployees.length === 0}>
            Auto-Match by Email
          </WriteButton>
          <WriteButton variant="filled" size="sm" leftSection={<IconPlayerPlay size={14} />} onClick={handleSync} loading={isPending} disabled={employeeMappingCount === 0}>
            Sync Now
          </WriteButton>
          <WriteButton variant="subtle" color="red" size="sm" onClick={() => setConfirmDisconnectOpen(true)}>
            Disconnect
          </WriteButton>
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
            <Badge color={SYNC_STATUS_COLOR[connection.lastSyncStatus] ?? 'gray'} variant="light">
              {connection.lastSyncStatus}
            </Badge>
          )}
        </Group>
      </Paper>

      {gustoEmployees.length === 0 && (
        <Alert color="signal" variant="light" mb="xl">
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
            <Table.ScrollContainer minWidth={500}>

            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>CadenzPoint Employee</Table.Th>
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
                        <MappingSelect
                          provider="Gusto"
                          name={emp.fullName}
                          mapping={mapping}
                          options={gustoEmployees.map((ge) => ({
                            value: ge.id,
                            label: `${ge.name}${ge.email ? ` (${ge.email})` : ''}`,
                          }))}
                          loaded={gustoEmployees.length > 0}
                          busy={busyRows.has(emp.id)}
                          placeholder="Select Gusto employee..."
                          emptyMessage="Load Gusto Employees first"
                          onSelect={(value) => {
                            const ge = gustoEmployees.find((e) => e.id === value);
                            void handleSaveMapping('employee', emp.id, emp.fullName, value, ge?.name ?? value);
                          }}
                          onClear={() => void handleClearMapping(emp.id, emp.fullName)}
                        />
                      </Table.Td>
                      <Table.Td>
                        {mapping ? (
                          <Badge color="success" variant="light" size="sm" leftSection={<IconCheck size={10} />}>Mapped</Badge>
                        ) : (
                          <Badge color="gray" variant="light" size="sm" leftSection={<IconX size={10} />}>Unmapped</Badge>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
            </Table.ScrollContainer>
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
                      <Table.Td>{formatDateTime(log.createdAt, workspaceTimezone)}</Table.Td>
                      <Table.Td><Badge size="xs" variant="light">{log.triggerType}</Badge></Table.Td>
                      <Table.Td>{log.recordsPushed}</Table.Td>
                      <Table.Td>{log.recordsFailed > 0 ? <Text c="red" size="sm" fw={600}>{log.recordsFailed}</Text> : '0'}</Table.Td>
                      <Table.Td>{log.recordsSkipped}</Table.Td>
                      <Table.Td>
                        <Badge color={SYNC_STATUS_COLOR[log.status] ?? 'gray'} variant="light" size="sm">{log.status}</Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
          </Paper>
        </Tabs.Panel>
      </Tabs>

      <ConfirmModal
        opened={confirmDisconnectOpen}
        title="Disconnect Gusto?"
        message="Tokens will be removed. Mappings and sync logs will be preserved."
        confirmLabel="Disconnect"
        loading={disconnecting}
        onConfirm={handleDisconnect}
        onCancel={() => setConfirmDisconnectOpen(false)}
      />
    </Container>
  );
}
