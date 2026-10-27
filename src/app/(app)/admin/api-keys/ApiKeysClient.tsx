'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Modal,
  TextInput,
  Select,
  Group,
  Stack,
  Badge,
  ActionIcon,
  Alert,
  Text,
  Code,
  CopyButton,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { IconPlus, IconTrash, IconBan, IconCheck, IconCopy, IconKey } from '@tabler/icons-react';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { createApiKey, revokeApiKey, deleteApiKey, getApiKeys } from '@/server/actions/api-keys';
import { formatDateTime } from '@/lib/format';
import { RECORD_STATUS_COLOR } from '@/lib/ui/status-colors';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';

type ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string;
  isActive: boolean;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
};

type Props = {
  initialKeys: ApiKey[];
  workspaceTimezone: string;
  };

type PendingAction = { key: ApiKey; action: 'revoke' | 'delete' };

export function ApiKeysClient({ initialKeys, workspaceTimezone }: Props) {
  const canWrite = useCanWrite();
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  const [isPending, startTransition] = useTransition();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newKeyModalOpen, setNewKeyModalOpen] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [form, setForm] = useState({ name: '', permissions: 'read' });
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  function handleCreate() {
    startTransition(async () => {
      setFormError(null);
      if (!form.name.trim()) {
        setFormError('Name is required.');
        return;
      }
      const result = await runAction(createApiKey({
        name: form.name.trim(),
        permissions: form.permissions as 'read' | 'read-write',
      }), { silent: true });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setNewKeyValue(result.data.key);
      setCreateModalOpen(false);
      setNewKeyModalOpen(true);
      setForm({ name: '', permissions: 'read' });
      const refreshed = await getApiKeys();
      setKeys(refreshed as ApiKey[]);
    });
  }

  function handleRevoke(key: ApiKey) {
    startTransition(async () => {
      const result = await runAction(revokeApiKey(key.id), { errorTitle: 'Couldn’t revoke key' });
      if (!result.ok) return;
      const refreshed = await getApiKeys();
      setKeys(refreshed as ApiKey[]);
      notifications.show({ title: 'Key Revoked', message: `"${key.name}" has been revoked.`, color: 'warning' });
      setPendingAction(null);
    });
  }

  function handleDelete(key: ApiKey) {
    startTransition(async () => {
      const result = await runAction(deleteApiKey(key.id), { errorTitle: 'Couldn’t delete key' });
      if (!result.ok) return;
      const refreshed = await getApiKeys();
      setKeys(refreshed as ApiKey[]);
      notifications.show({ title: 'Key Deleted', message: `"${key.name}" has been deleted.`, color: 'red' });
      setPendingAction(null);
    });
  }

  const columns: MRT_ColumnDef<ApiKey>[] = [
    { accessorKey: 'name', header: 'Name', size: 200 },
    {
      accessorKey: 'keyPrefix',
      header: 'Key Prefix',
      Cell: ({ cell }) => <Code>{cell.getValue<string>()}...</Code>,
      size: 120,
    },
    {
      accessorKey: 'permissions',
      header: 'Permissions',
      Cell: ({ cell }) => (
        <Badge color={cell.getValue<string>() === 'read-write' ? 'warning' : 'signal'}>
          {cell.getValue<string>()}
        </Badge>
      ),
      size: 120,
    },
    {
      accessorKey: 'isActive',
      header: 'Status',
      Cell: ({ cell }) => {
        const active = cell.getValue<boolean>();
        return (
          <Badge color={active ? RECORD_STATUS_COLOR.active : RECORD_STATUS_COLOR.inactive}>
            {active ? 'Active' : 'Revoked'}
          </Badge>
        );
      },
      size: 100,
    },
    {
      accessorKey: 'lastUsedAt',
      header: 'Last Used',
      Cell: ({ cell }) => formatDateTime(cell.getValue<Date | null>(), workspaceTimezone),
      size: 130,
    },
    {
      accessorKey: 'expiresAt',
      header: 'Expires',
      Cell: ({ cell }) => {
        const val = cell.getValue<Date | null>();
        return val ? formatDateTime(val, workspaceTimezone) : 'Never';
      },
      size: 120,
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      Cell: ({ cell }) => formatDateTime(cell.getValue<Date>(), workspaceTimezone),
      size: 120,
    },
  ];

  const table = useAppTable({
    columns,
    data: keys,
    enableRowActions: true,
    renderRowActions: ({ row }) => (
      <Group gap="xs" wrap="nowrap" justify="center">
        {row.original.isActive && (
          <Tooltip label="Revoke">
            <ActionIcon
              variant="subtle"
              color="warning"
              onClick={() => setPendingAction({ key: row.original, action: 'revoke' })}
              disabled={!canWrite || (isPending)}
              aria-label="Revoke key"
            >
              <IconBan size={16} />
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label="Delete">
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={() => setPendingAction({ key: row.original, action: 'delete' })}
            disabled={!canWrite || (isPending)}
            aria-label="Delete key"
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    ),
    displayColumnDefOptions: {
      'mrt-row-actions': {
        mantineTableHeadCellProps: { style: { textAlign: 'center' as const } },
        mantineTableBodyCellProps: { style: { textAlign: 'center' as const } },
      },
    },
  });

  return (
    <>
      <PageHeader
        title="API Keys"
        actions={
          <WriteButton leftSection={<IconPlus size={16} />} onClick={() => setCreateModalOpen(true)}>
            Create API Key
          </WriteButton>
        }
      />
      <MantineReactTable table={table} />

      {/* Create Key Modal */}
      <Modal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create API Key"
        size="sm"
      >
        <Stack>
          <TextInput
            label="Name"
            placeholder="e.g., QuickBooks Integration"
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Select
            label="Permissions"
            data={[
              { value: 'read', label: 'Read Only' },
              { value: 'read-write', label: 'Read & Write' },
            ]}
            value={form.permissions}
            onChange={(val) => setForm((f) => ({ ...f, permissions: val ?? 'read' }))}
          />
          {formError && (
            <Alert color="red">{formError}</Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCreateModalOpen(false)}>Cancel</Button>
            <WriteButton onClick={handleCreate} loading={isPending} leftSection={<IconKey size={16} />}>
              Generate Key
            </WriteButton>
          </Group>
        </Stack>
      </Modal>

      {/* New Key Display Modal (one-time) */}
      <Modal
        opened={newKeyModalOpen}
        onClose={() => { setNewKeyModalOpen(false); setNewKeyValue(''); }}
        title="API Key Created — Copy Now!"
        size="md"
        closeOnClickOutside={false}
      >
        <Stack>
          <Alert color="warning">
            <Text size="sm" fw={600}>This key will only be shown once.</Text>
            <Text size="sm">Copy it now and store it securely. You cannot retrieve it again.</Text>
          </Alert>
          <Group>
            <Code style={{ flex: 1, wordBreak: 'break-all', padding: '12px' }}>
              {newKeyValue}
            </Code>
            <CopyButton value={newKeyValue}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied!' : 'Copy'}>
                  <ActionIcon color={copied ? 'success' : 'signal'} onClick={copy} size="lg">
                    {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
          {/* The API's 401 no longer carries a usage hint (one identical body for every auth failure), so it lives here. */}
          <Text size="sm" c="dimmed">
            Send it on every request as the header <Code>Authorization: Bearer {'<key>'}</Code>.
          </Text>
          {/* certified-outputs C3 (ruling Q6): the additive cost-basis fields, so integrations don't under-report. */}
          <Text size="sm" c="dimmed">
            <Code>/api/v1/costs</Code> returns <Code>costBasis</Code> and <Code>unpricedHours</Code> on every row and the
            total <Code>unpricedHours</Code> in <Code>meta</Code>: hours with no applicable labor category carry no cost,
            so add them to your checks rather than reading the cost alone. On those rows <Code>lcatTitle</Code> is{' '}
            <Code>Unpriced</Code> (no labor category applied) and <Code>totalCost</Code> is 0.
          </Text>
          {/* feature-plan-dated-rates.md D2: rates are dated. */}
          <Text size="sm" c="dimmed">
            Each row&apos;s <Code>hourlyRate</Code> is the labor-category rate in effect on that entry&apos;s date, so one
            labor category can appear at different rates across a range.
          </Text>
          <Button onClick={() => { setNewKeyModalOpen(false); setNewKeyValue(''); }} color="success">
            I've Copied the Key
          </Button>
        </Stack>
      </Modal>

      <ConfirmModal
        opened={!!pendingAction}
        title={pendingAction?.action === 'delete' ? 'Delete API key?' : 'Revoke API key?'}
        message={
          pendingAction
            ? pendingAction.action === 'delete'
              ? `This permanently deletes "${pendingAction.key.name}". This cannot be undone.`
              : `This revokes "${pendingAction.key.name}". Requests using it will stop working immediately.`
            : ''
        }
        confirmLabel={pendingAction?.action === 'delete' ? 'Delete' : 'Revoke'}
        loading={isPending}
        onConfirm={() => {
          if (!pendingAction) return;
          if (pendingAction.action === 'delete') handleDelete(pendingAction.key);
          else handleRevoke(pendingAction.key);
        }}
        onCancel={() => setPendingAction(null)}
      />
    </>
  );
}
