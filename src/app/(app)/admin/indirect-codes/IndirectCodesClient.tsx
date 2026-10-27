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
  Badge,
  Switch,
  ActionIcon,
  Tooltip,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { IconPlus, IconEdit } from '@tabler/icons-react';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { createIndirectCode, updateIndirectCode, getIndirectChargeCodes, seedIndirectCodes } from '@/server/actions/indirect-codes';
import { PageHeader } from '@/components/ui/PageHeader';
import { INDIRECT_CATEGORY_COLOR } from '@/lib/ui/status-colors';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';

type IndirectCode = {
  id: string;
  code: string;
  name: string;
  category: 'overhead' | 'ga' | 'irad' | 'bp' | 'leave' | 'unallowable';
  description: string | null;
  isActive: boolean;
  availableToAll: boolean;
  leavePayType: string | null;
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

const CATEGORY_LABELS: Record<string, string> = {
  overhead: 'Overhead',
  ga: 'G&A',
  irad: 'IR&D',
  bp: 'B&P',
  leave: 'Leave',
  unallowable: 'Unallowable',
};

/** certified-outputs C7 (CO-D11): how a leave code's hours are paid; required for leave codes. */
const LEAVE_PAY_TYPE_OPTIONS = [
  { value: 'pto', label: 'PTO (paid time off)' },
  { value: 'sick', label: 'Sick (paid)' },
  { value: 'holiday', label: 'Holiday (paid)' },
  { value: 'unpaid', label: 'Unpaid' },
];
const LEAVE_PAY_TYPE_LABELS: Record<string, string> = { pto: 'PTO', sick: 'Sick', holiday: 'Holiday', unpaid: 'Unpaid' };

type CodeForm = {
  code: string;
  name: string;
  category: string;
  description: string;
  availableToAll: boolean;
  leavePayType: string | null;
};

const EMPTY_FORM: CodeForm = {
  code: '',
  name: '',
  category: 'overhead',
  description: '',
  availableToAll: true,
  leavePayType: null,
};

export function IndirectCodesClient({ initialCodes }: Props) {
  const canWrite = useCanWrite();
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
      leavePayType: code.leavePayType,
    });
    setFormError(null);
    setModalOpen(true);
  }

  function handleSubmit() {
    startTransition(async () => {
      setFormError(null);
      if (!form.code || !form.name || !form.category) {
        setFormError('Code, Name, and Category are required.');
        return;
      }
      if (form.category === 'leave' && !form.leavePayType) {
        setFormError('Choose a pay type for a leave code — payroll export needs it.');
        return;
      }

      const fields = {
        code: form.code,
        name: form.name,
        category: form.category as IndirectCode['category'],
        description: form.description || undefined,
        availableToAll: form.availableToAll,
        leavePayType: form.category === 'leave' ? (form.leavePayType as 'pto' | 'sick' | 'holiday' | 'unpaid' | null) : null,
      };
      // silent: the error is shown inside the form.
      const result = editingCode
        ? await runAction(updateIndirectCode(editingCode.id, fields), { silent: true })
        : await runAction(createIndirectCode(fields), { silent: true });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      notifications.show(editingCode
        ? { title: 'Code Updated', message: `${form.name} has been updated.`, color: 'success' }
        : { title: 'Code Created', message: `${form.name} has been created.`, color: 'success' });

      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      setModalOpen(false);
    });
  }

  function handleToggleActive(code: IndirectCode) {
    startTransition(async () => {
      const result = await runAction(updateIndirectCode(code.id, { isActive: !code.isActive }), { errorTitle: 'Couldn’t update code' });
      if (!result.ok) return;
      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      notifications.show({
        title: code.isActive ? 'Code Deactivated' : 'Code Activated',
        message: `${code.name} is now ${code.isActive ? 'inactive' : 'active'}.`,
        color: code.isActive ? 'warning' : 'success',
      });
    });
  }

  function handleSeedDefaults() {
    startTransition(async () => {
      const result = await runAction(seedIndirectCodes(), { errorTitle: 'Couldn’t seed defaults' });
      if (!result.ok) return;
      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      notifications.show({ title: 'Defaults Seeded', message: 'Default indirect charge codes have been created.', color: 'success' });
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
        return <Badge color={INDIRECT_CATEGORY_COLOR[cat] ?? 'gray'}>{CATEGORY_LABELS[cat] ?? cat}</Badge>;
      },
      size: 140,
    },
    {
      accessorKey: 'leavePayType',
      header: 'Pay type',
      Cell: ({ row }) => row.original.category !== 'leave'
        ? <Text size="sm" c="dimmed">—</Text>
        : row.original.leavePayType
          ? LEAVE_PAY_TYPE_LABELS[row.original.leavePayType]
          : <Badge color="red" variant="light">Not set — blocks payroll export</Badge>,
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
          disabled={!canWrite || (isPending)}
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

  const table = useAppTable({
    columns,
    data: codes,
    enableRowActions: true,
    renderRowActions: ({ row }) => (
      <Tooltip label="Edit">
        <ActionIcon disabled={!canWrite} variant="subtle" onClick={() => openEditModal(row.original)} aria-label="Edit indirect code">
          <IconEdit size={16} />
        </ActionIcon>
      </Tooltip>
    ),
  });

  return (
    <>
      <PageHeader
        title="Indirect Charge Codes"
        actions={
          <Group>
            <WriteButton leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
              Add Code
            </WriteButton>
            <WriteButton variant="default" onClick={handleSeedDefaults} loading={isPending}>
              Seed Defaults
            </WriteButton>
          </Group>
        }
      />
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
          {form.category === 'leave' && (
            <Select
              label="Pay type"
              description="How these hours are paid in the payroll export (its own column; unpaid is never paid)."
              data={LEAVE_PAY_TYPE_OPTIONS}
              value={form.leavePayType}
              onChange={(val) => setForm((f) => ({ ...f, leavePayType: val }))}
              required
              data-testid="leave-pay-type"
            />
          )}
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
            <Badge color="red" size="lg" style={{ whiteSpace: 'normal', height: 'auto', padding: '8px' }}>
              {formError}
            </Badge>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpen(false)}>Cancel</Button>
            <WriteButton onClick={handleSubmit} loading={isPending}>
              {editingCode ? 'Save Changes' : 'Create Code'}
            </WriteButton>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
