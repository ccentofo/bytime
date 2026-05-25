'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Modal,
  TextInput,
  Select,
  Textarea,
  Group,
  Stack,
  Title,
  Badge,
  Switch,
  ActionIcon,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconEdit } from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { createIndirectCode, updateIndirectCode, getIndirectChargeCodes, seedIndirectCodes } from '@/server/actions/indirect-codes';
import classes from './IndirectCodes.module.css';

type IndirectCode = {
  id: string;
  code: string;
  name: string;
  category: 'overhead' | 'ga' | 'irad' | 'bp' | 'leave' | 'unallowable';
  description: string | null;
  isActive: boolean;
  availableToAll: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type Props = {
  initialCodes: IndirectCode[];
};

const CATEGORY_OPTIONS = [
  { value: 'overhead', label: 'Overhead' },
  { value: 'ga', label: 'G&A (General & Administrative)' },
  { value: 'irad', label: 'IR&D (Independent R&D)' },
  { value: 'bp', label: 'B&P (Bid & Proposal)' },
  { value: 'leave', label: 'Leave' },
  { value: 'unallowable', label: 'Unallowable (FAR 31.205)' },
];

const CATEGORY_COLORS: Record<string, string> = {
  overhead: 'blue',
  ga: 'grape',
  irad: 'cyan',
  bp: 'orange',
  leave: 'green',
  unallowable: 'red',
};

const CATEGORY_LABELS: Record<string, string> = {
  overhead: 'Overhead',
  ga: 'G&A',
  irad: 'IR&D',
  bp: 'B&P',
  leave: 'Leave',
  unallowable: 'Unallowable',
};

type CodeForm = {
  code: string;
  name: string;
  category: string;
  description: string;
  availableToAll: boolean;
};

const EMPTY_FORM: CodeForm = {
  code: '',
  name: '',
  category: 'overhead',
  description: '',
  availableToAll: true,
};

export function IndirectCodesClient({ initialCodes }: Props) {
  const [codes, setCodes] = useState<IndirectCode[]>(initialCodes);
  const [isPending, startTransition] = useTransition();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCode, setEditingCode] = useState<IndirectCode | null>(null);
  const [form, setForm] = useState<CodeForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  function openCreateModal() {
    setEditingCode(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function openEditModal(code: IndirectCode) {
    setEditingCode(code);
    setForm({
      code: code.code,
      name: code.name,
      category: code.category,
      description: code.description ?? '',
      availableToAll: code.availableToAll,
    });
    setFormError(null);
    setModalOpen(true);
  }

  function handleSubmit() {
    startTransition(async () => {
      try {
        setFormError(null);
        if (!form.code || !form.name || !form.category) {
          setFormError('Code, Name, and Category are required.');
          return;
        }

        if (editingCode) {
          await updateIndirectCode(editingCode.id, {
            code: form.code,
            name: form.name,
            category: form.category as IndirectCode['category'],
            description: form.description || undefined,
            availableToAll: form.availableToAll,
          });
          notifications.show({ title: 'Code Updated', message: `${form.name} has been updated.`, color: 'green' });
        } else {
          await createIndirectCode({
            code: form.code,
            name: form.name,
            category: form.category as IndirectCode['category'],
            description: form.description || undefined,
            availableToAll: form.availableToAll,
          });
          notifications.show({ title: 'Code Created', message: `${form.name} has been created.`, color: 'green' });
        }

        const refreshed = await getIndirectChargeCodes();
        setCodes(refreshed as IndirectCode[]);
        setModalOpen(false);
      } catch (error) {
        setFormError(String(error));
      }
    });
  }

  function handleToggleActive(code: IndirectCode) {
    startTransition(async () => {
      await updateIndirectCode(code.id, { isActive: !code.isActive });
      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      notifications.show({
        title: code.isActive ? 'Code Deactivated' : 'Code Activated',
        message: `${code.name} is now ${code.isActive ? 'inactive' : 'active'}.`,
        color: code.isActive ? 'yellow' : 'green',
      });
    });
  }

  function handleSeedDefaults() {
    startTransition(async () => {
      await seedIndirectCodes();
      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      notifications.show({ title: 'Defaults Seeded', message: 'Default indirect charge codes have been created.', color: 'green' });
    });
  }

  const columns: MRT_ColumnDef<IndirectCode>[] = [
    { accessorKey: 'code', header: 'Code', size: 120 },
    { accessorKey: 'name', header: 'Name', size: 200 },
    {
      accessorKey: 'category',
      header: 'Category',
      Cell: ({ cell }) => {
        const cat = cell.getValue<string>();
        return <Badge color={CATEGORY_COLORS[cat] ?? 'gray'} variant="light">{CATEGORY_LABELS[cat] ?? cat}</Badge>;
      },
      size: 140,
    },
    { accessorKey: 'description', header: 'Description', size: 250 },
    {
      accessorKey: 'isActive',
      header: 'Active',
      Cell: ({ row }) => (
        <Switch
          checked={row.original.isActive}
          onChange={() => handleToggleActive(row.original)}
          disabled={isPending}
          size="sm"
        />
      ),
      size: 90,
    },
    {
      accessorKey: 'availableToAll',
      header: 'All Employees',
      Cell: ({ cell }) => cell.getValue<boolean>() ? 'Yes' : 'No',
      size: 120,
    },
  ];

  const table = useMantineReactTable({
    columns,
    data: codes,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <ActionIcon variant="subtle" onClick={() => openEditModal(row.original)} title="Edit">
        <IconEdit size={16} />
      </ActionIcon>
    ),
    renderTopToolbarCustomActions: () => (
      <Group>
        <Button leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
          Add Code
        </Button>
        <Button variant="default" onClick={handleSeedDefaults} loading={isPending}>
          Seed Defaults
        </Button>
      </Group>
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
        size: 80,
        mantineTableHeadCellProps: { style: { textAlign: 'center' as const, padding: '12px 16px' } },
        mantineTableBodyCellProps: { style: { textAlign: 'center' as const, padding: '12px 16px' } },
      },
    },
  });

  return (
    <>
      <Title order={2} mb="md">Indirect Charge Codes</Title>
      <MantineReactTable table={table} />

      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingCode ? 'Edit Indirect Code' : 'Create Indirect Code'}
        size="md"
      >
        <Stack>
          <TextInput
            label="Code"
            placeholder="e.g., OH-001, LV-AL"
            required
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
          />
          <TextInput
            label="Name"
            placeholder="e.g., Overhead, Annual Leave"
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Select
            label="Category"
            data={CATEGORY_OPTIONS}
            value={form.category}
            onChange={(val) => setForm((f) => ({ ...f, category: val ?? 'overhead' }))}
            required
          />
          <Textarea
            label="Description"
            placeholder="Optional description"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            minRows={2}
          />
          <Switch
            label="Available to All Employees"
            checked={form.availableToAll}
            onChange={(e) => setForm((f) => ({ ...f, availableToAll: e.currentTarget.checked }))}
          />
          {formError && (
            <Badge color="red" variant="light" size="lg" style={{ whiteSpace: 'normal', height: 'auto', padding: '8px' }}>
              {formError}
            </Badge>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} loading={isPending}>
              {editingCode ? 'Save Changes' : 'Create Code'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
