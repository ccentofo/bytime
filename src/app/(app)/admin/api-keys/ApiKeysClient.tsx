'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Modal,
  TextInput,
  Select,
  Group,
  Stack,
  Title,
  Badge,
  ActionIcon,
  Alert,
  Text,
  Code,
  CopyButton,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash, IconBan, IconCheck, IconCopy, IconKey } from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { createApiKey, revokeApiKey, deleteApiKey, getApiKeys } from '@/server/actions/api-keys';
import dayjs from 'dayjs';
import classes from './ApiKeys.module.css';

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
  currentUserId: string;
};

export function ApiKeysClient({ initialKeys, currentUserId }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  const [isPending, startTransition] = useTransition();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newKeyModalOpen, setNewKeyModalOpen] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [form, setForm] = useState({ name: '', permissions: 'read' });
  const [formError, setFormError] = useState<string | null>(null);

  function handleCreate() {
    startTransition(async () => {
      try {
        setFormError(null);
        if (!form.name.trim()) {
          setFormError('Name is required.');
          return;
        }
        const result = await createApiKey({
          name: form.name.trim(),
          createdByUserId: currentUserId,
          permissions: form.permissions as 'read' | 'read-write',
        });
        setNewKeyValue(result.key);
        setCreateModalOpen(false);
        setNewKeyModalOpen(true);
        setForm({ name: '', permissions: 'read' });
        const refreshed = await getApiKeys();
        setKeys(refreshed as ApiKey[]);
      } catch (error) {
        setFormError(String(error));
      }
    });
  }

  function handleRevoke(key: ApiKey) {
    startTransition(async () => {
      await revokeApiKey(key.id);
      const refreshed = await getApiKeys();
      setKeys(refreshed as ApiKey[]);
      notifications.show({ title: 'Key Revoked', message: `"${key.name}" has been revoked.`, color: 'orange' });
    });
  }

  function handleDelete(key: ApiKey) {
    startTransition(async () => {
      await deleteApiKey(key.id);
      const refreshed = await getApiKeys();
      setKeys(refreshed as ApiKey[]);
      notifications.show({ title: 'Key Deleted', message: `"${key.name}" has been deleted.`, color: 'red' });
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
        <Badge color={cell.getValue<string>() === 'read-write' ? 'orange' : 'blue'} variant="light">
          {cell.getValue<string>()}
        </Badge>
      ),
      size: 120,
    },
    {
      accessorKey: 'isActive',
      header: 'Status',
      Cell: ({ cell }) => (
        <Badge color={cell.getValue<boolean>() ? 'green' : 'gray'} variant="light">
          {cell.getValue<boolean>() ? 'Active' : 'Revoked'}
        </Badge>
      ),
      size: 100,
    },
    {
      accessorKey: 'lastUsedAt',
      header: 'Last Used',
      Cell: ({ cell }) => {
        const val = cell.getValue<Date | null>();
        return val ? dayjs(val).format('MMM D, YYYY') : '—';
      },
      size: 130,
    },
    {
      accessorKey: 'expiresAt',
      header: 'Expires',
      Cell: ({ cell }) => {
        const val = cell.getValue<Date | null>();
        return val ? dayjs(val).format('MMM D, YYYY') : 'Never';
      },
      size: 120,
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      Cell: ({ cell }) => dayjs(cell.getValue<Date>()).format('MMM D, YYYY'),
      size: 120,
    },
  ];

  const table = useMantineReactTable({
    columns,
    data: keys,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Group gap="xs" wrap="nowrap">
        {row.original.isActive && (
          <ActionIcon
            variant="subtle"
            color="orange"
            onClick={() => handleRevoke(row.original)}
            title="Revoke Key"
            disabled={isPending}
          >
            <IconBan size={16} />
          </ActionIcon>
        )}
        <ActionIcon
          variant="subtle"
          color="red"
          onClick={() => handleDelete(row.original)}
          title="Delete Key"
          disabled={isPending}
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    ),
    renderTopToolbarCustomActions: () => (
      <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateModalOpen(true)}>
        Create API Key
      </Button>
    ),
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: { highlightOnHover: true, striped: 'odd', withColumnBorders: false },
    mantineTableHeadCellProps: {
      className: classes.tableHeaderCell,
      style: { fontWeight: 600, fontSize: '0.85rem', padding: '12px 16px' },
    },
    mantineTableBodyCellProps: { style: { fontSize: '0.875rem', padding: '12px 16px' } },
    mantineTopToolbarProps: { style: { padding: '12px 16px' } },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
        mantineTableHeadCellProps: { style: { textAlign: 'center' as const, padding: '12px 16px' } },
        mantineTableBodyCellProps: { style: { textAlign: 'center' as const, padding: '12px 16px' } },
      },
    },
  });

  return (
    <>
      <Title order={2} mb="md">API Keys</Title>
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
            <Alert color="red" variant="light">{formError}</Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCreateModalOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} loading={isPending} leftSection={<IconKey size={16} />}>
              Generate Key
            </Button>
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
          <Alert color="orange" variant="light">
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
                  <ActionIcon color={copied ? 'green' : 'blue'} onClick={copy} size="lg">
                    {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
          <Button onClick={() => { setNewKeyModalOpen(false); setNewKeyValue(''); }} color="green">
            I've Copied the Key
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
