'use client';

import { useEffect, useImperativeHandle, useState, useTransition, type Ref } from 'react';
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
  Text,
  Loader,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { addedStandardCodes } from '@/lib/ui/indirect-seed-copy';
import { RowActions } from '@/components/ui/RowActions';
import { useBusyRows, useLastTarget } from '@/components/ui/useRowState';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { createIndirectCode, updateIndirectCode, getIndirectChargeCodes, seedIndirectCodes } from '@/server/actions/indirect-codes';
import { INDIRECT_CATEGORY_COLOR, RECORD_STATUS_COLOR } from '@/lib/ui/status-colors';
import { WriteButton } from '@/components/shell/WorkspaceMode';

export type IndirectCode = {
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

/** The page header's "Add indirect code" opens this panel's form (feature-plan-ux-people-codes.md §3.1). */
export interface IndirectPanelHandle { openCreate: () => void }

type Props = {
  initialCodes: IndirectCode[];
  ref?: Ref<IndirectPanelHandle>;
  /** The tab's count follows the list. */
  onCountChange?: (n: number) => void;
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

export function IndirectCodesPanel({ initialCodes, ref, onCountChange }: Props) {
  // Deactivate asks first (feature-plan-ux-foundations.md §4.5, B2); Reactivate runs directly with a row loader.
  const [confirmDeactivate, setConfirmDeactivate] = useState<IndirectCode | null>(null);
  const busyRows = useBusyRows();
  const shownDeactivate = useLastTarget(confirmDeactivate); // kept while the modal animates closed
  const [codes, setCodes] = useState<IndirectCode[]>(initialCodes);
  const [isPending, startTransition] = useTransition();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCode, setEditingCode] = useState<IndirectCode | null>(null);
  const [form, setForm] = useState<CodeForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  // C2: turning "Show on every timesheet" off asks first; the form's own error shows inside this confirm while it's open.
  const [hideConfirm, setHideConfirm] = useState(false);

  function openCreateModal() {
    setEditingCode(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }
  useImperativeHandle(ref, () => ({ openCreate: openCreateModal }));
  useEffect(() => { onCountChange?.(codes.filter((c) => c.isActive).length); }, [codes, onCountChange]);

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

  /** `confirmed`: the hide confirm was accepted (feature-plan-ux-page-fixes.md C2). Wired as `() => handleSubmit()`. */
  function handleSubmit({ confirmed = false }: { confirmed?: boolean } = {}) {
    setFormError(null);
    if (!form.code || !form.name || !form.category) {
      setFormError('Code, Name, and Category are required.');
      return;
    }
    if (form.category === 'leave' && !form.leavePayType) {
      setFormError('Choose a pay type for a leave code — payroll export needs it.');
      return;
    }
    if (editingCode?.availableToAll && !form.availableToAll && !confirmed) {
      setHideConfirm(true);
      return;
    }
    startTransition(async () => {

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
      setHideConfirm(false);
      notifications.show(editingCode
        ? { title: 'Code Updated', message: `${form.name} has been updated.`, color: 'success' }
        : { title: 'Code Created', message: `${form.name} has been created.`, color: 'success' });

      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      setModalOpen(false);
    });
  }

  /** Same server call as before; the confirm closes only on success (onDone). */
  function handleToggleActive(code: IndirectCode, onDone?: () => void) {
    if (!onDone) busyRows.start(code.id);
    startTransition(async () => {
      const result = await runAction(updateIndirectCode(code.id, { isActive: !code.isActive }), { errorTitle: 'Couldn’t update code' });
      busyRows.done(code.id);
      if (!result.ok) return;
      onDone?.();
      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      notifications.show({
        title: code.isActive ? 'Code Deactivated' : 'Code Activated',
        message: `${code.name} is now ${code.isActive ? 'inactive' : 'active'}.`,
        color: code.isActive ? 'warning' : 'success',
      });
    });
  }

  // C3: adds the standard codes only to a workspace that has none; says honestly when none were added.
  const [seeding, setSeeding] = useState(false);
  async function handleSeedDefaults() {
    if (seeding) return;
    setSeeding(true);
    try {
      const result = await runAction(seedIndirectCodes(), { errorTitle: 'Couldn’t add the standard codes' });
      if (!result.ok) return;
      const { created } = result.data;
      // UX-4A-AUDIT.md L5: a failed refetch after a successful seed says so, rather than throwing out of the handler.
      let refreshed: IndirectCode[] | null = null;
      try {
        refreshed = (await getIndirectChargeCodes()) as IndirectCode[];
      } catch {
        refreshed = null;
      }
      if (refreshed) setCodes(refreshed);
      notifications.show(created > 0 && !refreshed
        ? { title: 'Standard codes added', message: "Codes were added, but the list couldn't refresh. Reload the page.", color: 'warning' }
        : created > 0
          ? { title: 'Standard codes added', message: addedStandardCodes(created), color: 'success' }
          : { title: 'No codes added', message: 'Your workspace already has indirect codes, so none were added.', color: 'gray' });
    } finally {
      setSeeding(false);
    }
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
      // The word, so the table search finds "Inactive" (UX-1 audit L3).
      id: 'isActive',
      accessorFn: (r) => (r.isActive ? 'Active' : 'Inactive'),
      header: 'Status',
      Cell: ({ row }) => (
        <Badge color={row.original.isActive ? RECORD_STATUS_COLOR.active : RECORD_STATUS_COLOR.inactive}>
          {row.original.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
      size: 100,
    },
    {
      // C2: the word, so the table search finds it; an inactive code is on no timesheet whatever the flag says.
      id: 'availableToAll',
      accessorFn: (r) => (!r.isActive ? 'Inactive' : r.availableToAll ? 'Yes' : 'Hidden'),
      header: 'On timesheets',
      size: 120,
    },
  ];

  const table = useAppTable({
    columns,
    data: codes,
    // C3: the standard-codes offer lives in the empty state of a workspace with NO codes — never for a search with no
    // matches (MRT renders this fallback for both).
    renderEmptyRowsFallback: codes.length === 0 ? () => (
      <Stack align="center" gap="sm" py="xl">
        <Text size="sm">No indirect codes yet. Add the standard DCAA set (overhead, G&amp;A, IR&amp;D, B&amp;P, leave and unallowable) or create your own.</Text>
        <WriteButton
          variant="default"
          onClick={handleSeedDefaults}
          aria-disabled={seeding || undefined}
          leftSection={seeding ? <Loader size={14} aria-hidden="true" /> : undefined}
        >
          Add standard codes
        </WriteButton>
      </Stack>
    ) : undefined,
    enableRowActions: true,
    renderRowActions: ({ row }) => {
      const code = row.original;
      return (
        <RowActions
          rowLabel={code.code}
          primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEditModal(code) }}
          items={[
            code.isActive
              ? { key: 'deactivate', label: 'Deactivate…', icon: 'deactivate', tone: 'danger', onSelect: () => setConfirmDeactivate(code) }
              : { key: 'reactivate', label: 'Reactivate', icon: 'reactivate', busy: busyRows.isBusy(code.id), onSelect: () => handleToggleActive(code) },
          ]}
        />
      );
    },
  });

  return (
    <>
      <MantineReactTable table={table} />

      <ConfirmModal
        opened={!!confirmDeactivate}
        title={`Deactivate ${shownDeactivate?.code ?? ''}?`}
        message="Employees can't charge new time to it. Existing hours stay on record."
        confirmLabel="Deactivate"
        loading={isPending}
        onConfirm={() => confirmDeactivate && handleToggleActive(confirmDeactivate, () => setConfirmDeactivate(null))}
        onCancel={() => setConfirmDeactivate(null)}
      />

      <ConfirmModal
        opened={hideConfirm}
        tone="danger"
        title={`Hide ${form.code} from timesheets?`}
        message={`Employees won't be able to add ${form.code} or record new hours on it. Rows that already have hours stay visible in their period for corrections and notes.`}
        confirmLabel="Hide code"
        loading={isPending}
        error={formError}
        onConfirm={() => handleSubmit({ confirmed: true })}
        onCancel={() => { setHideConfirm(false); setFormError(null); }}
      />

      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        // Every open modal listens for Esc on window: with the hide confirm open, Esc must close only the confirm.
        closeOnEscape={!hideConfirm}
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
            label="Show on every timesheet"
            description="When off, employees can't add this code or record new hours on it. Where hours are already recorded, the row stays in that period for corrections and notes."
            checked={form.availableToAll}
            onChange={(e) => { const checked = e.currentTarget.checked; setForm((f) => ({ ...f, availableToAll: checked })); }}
          />
          {/* While the hide confirm is open its error shows there instead (one error location). */}
          {formError && !hideConfirm && (
            <Badge color="red" size="lg" style={{ whiteSpace: 'normal', height: 'auto', padding: '8px' }}>
              {formError}
            </Badge>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpen(false)}>Cancel</Button>
            <WriteButton onClick={() => handleSubmit()} loading={isPending}>
              {editingCode ? 'Save Changes' : 'Create Code'}
            </WriteButton>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
