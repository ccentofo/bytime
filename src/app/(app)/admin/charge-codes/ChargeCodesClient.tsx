'use client';

import { useState, useTransition } from 'react';
import {
  Button, Modal, TextInput, Textarea, Select, Group, Stack,
  Badge, Switch,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { RowActions } from '@/components/ui/RowActions';
import { useBusyRows } from '@/components/ui/useRowState';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import {
  createChargeCode, updateChargeCode, deactivateChargeCode, reactivateChargeCode, getChargeCodeReactivationInfo,
  autobridgeChargeCodesFromClins, createCostClass, listChargeCodes,
} from '@/server/actions/charge-codes';
import { RECORD_STATUS_COLOR, WORK_LOCATION_COLOR } from '@/lib/ui/status-colors';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';
import { ChargeCodeCategoryModal, type CategoryOption } from './ChargeCodeCategoryModal';
import type { CategoryChange, CategoryScheduleView } from '@/lib/labor-rates';

type ChargeCodeRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  clinId: string;
  clinNumber: string;
  slinId: string | null;
  contractName: string;
  contractNumber: string;
  laborCategoryId: string | null;
  classId: string | null;
  className: string | null;
  workLocation: 'onsite' | 'telework' | 'other' | null;
  billable: boolean;
  isActive: boolean;
  createdAt: Date;
  /** Dated rates D3: laborCategoryId is the STARTING category; these are its dated changes. */
  categoryChanges: CategoryChange[];
};

type ClinOption = { id: string; clinNumber: string; description: string | null };
type ContractOption = { id: string; name: string; contractNumber: string; clins: ClinOption[] };

type Props = {
  initialCodes: ChargeCodeRow[];
  costClasses: Array<{ id: string; name: string }>;
  contracts: ContractOption[];
  laborCategories: CategoryOption[];
};

type CodeForm = {
  code: string;
  name: string;
  description: string;
  contractId: string;
  clinId: string;
  classId: string;
  workLocation: string;
  billable: boolean;
};

const EMPTY_FORM: CodeForm = {
  code: '', name: '', description: '',
  contractId: '', clinId: '', classId: '',
  workLocation: '', billable: true,
};

const WORK_LOCATION_OPTIONS = [
  { value: '', label: 'Not specified' },
  { value: 'onsite', label: 'Onsite' },
  { value: 'telework', label: 'Telework' },
  { value: 'other', label: 'Other' },
];


export function ChargeCodesClient({ initialCodes, costClasses, contracts, laborCategories }: Props) {
  const canWrite = useCanWrite();
  const [codes, setCodes] = useState(initialCodes);
  // Dated rates D3: the "Labor category" modal; a saved schedule is merged back into the table's rows.
  const [categoryFor, setCategoryFor] = useState<ChargeCodeRow | null>(null);
  function mergeCategorySchedule(view: CategoryScheduleView) {
    setCodes((prev) => prev.map((c) => (c.id === view.chargeCodeId ? { ...c, laborCategoryId: view.starting, categoryChanges: view.changes } : c)));
  }
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CodeForm>(EMPTY_FORM);
  const [isPending, startTransition] = useTransition();
  const [newClassName, setNewClassName] = useState('');
  const [classList, setClassList] = useState(costClasses);
  const [confirmTarget, setConfirmTarget] = useState<ChargeCodeRow | null>(null);
  // certified-outputs C3 (CO-D8, ruling Q2): reactivation confirm — how many employees get the code back.
  // Reactivate fetches the code's info before its confirm opens: a loader on that row meanwhile.
  const busyRows = useBusyRows();
  const [reactivateTarget, setReactivateTarget] = useState<{ row: ChargeCodeRow; stillAssigned: number; assignable: boolean } | null>(null);

  async function refreshCodes() {
    const fresh = await listChargeCodes();
    setCodes(fresh as ChargeCodeRow[]);
  }

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(row: ChargeCodeRow) {
    // Find the contract for this code's CLIN
    const contract = contracts.find((c) => c.clins.some((cl) => cl.id === row.clinId));
    setEditingId(row.id);
    setForm({
      code: row.code,
      name: row.name,
      description: row.description ?? '',
      contractId: contract?.id ?? '',
      clinId: row.clinId,
      classId: row.classId ?? '',
      workLocation: row.workLocation ?? '',
      billable: row.billable,
    });
    setModalOpen(true);
  }

  async function handleSave() {
    if (!form.code.trim() || !form.name.trim() || !form.clinId) {
      notifications.show({ title: 'Required fields missing', message: 'Code, Name, and CLIN are required.', color: 'red' });
      return;
    }
    startTransition(async () => {
      const result = editingId
        ? await runAction(updateChargeCode(editingId, {
            code: form.code.trim(), name: form.name.trim(),
            description: form.description || undefined,
            clinId: form.clinId, classId: form.classId || null,
            workLocation: (form.workLocation as 'onsite' | 'telework' | 'other') || null,
            billable: form.billable,
          }), { errorTitle: 'Couldn’t update charge code' })
        : await runAction(createChargeCode({
            code: form.code.trim(), name: form.name.trim(),
            description: form.description || undefined,
            clinId: form.clinId, classId: form.classId || undefined,
            workLocation: (form.workLocation as 'onsite' | 'telework' | 'other') || undefined,
            billable: form.billable,
          }), { errorTitle: 'Couldn’t create charge code' });
      if (!result.ok) return; // the server's message is shown; the form stays open with the user's input
      notifications.show({ title: editingId ? 'Updated' : 'Created', message: `${form.code} ${editingId ? 'updated' : 'created'}.`, color: 'success' });
      setModalOpen(false);
      await refreshCodes();
    });
  }

  async function handleDeactivate(id: string, code: string) {
    startTransition(async () => {
      const result = await runAction(deactivateChargeCode(id), { errorTitle: 'Couldn’t deactivate' });
      if (!result.ok) return;
      notifications.show({ title: 'Deactivated', message: `${code} deactivated.`, color: 'warning' });
      setConfirmTarget(null);
      await refreshCodes();
    });
  }

  function openReactivate(row: ChargeCodeRow) {
    busyRows.start(row.id);
    startTransition(async () => {
      try {
        const info = await getChargeCodeReactivationInfo(row.id);
        setReactivateTarget({ row, ...info });
      } catch {
        notifications.show({ title: 'Couldn’t load the charge code', message: 'Refresh the page and try again.', color: 'red' });
      } finally {
        busyRows.done(row.id);
      }
    });
  }

  async function handleReactivate(id: string, code: string) {
    startTransition(async () => {
      const result = await runAction(reactivateChargeCode(id), { errorTitle: 'Couldn’t reactivate' });
      if (!result.ok) return;
      notifications.show({ title: 'Reactivated', message: `${code} reactivated.`, color: 'success' });
      setReactivateTarget(null);
      await refreshCodes();
    });
  }

  async function handleAutobridge() {
    startTransition(async () => {
      const result = await runAction(autobridgeChargeCodesFromClins(), { errorTitle: 'Couldn’t auto-generate codes' });
      if (!result.ok) return;
      notifications.show({ title: 'Auto-generated', message: `Created ${result.data.created} charge code(s) from ${result.data.total} active CLINs.`, color: 'success' });
      await refreshCodes();
    });
  }

  async function handleAddClass() {
    if (!newClassName.trim()) return;
    startTransition(async () => {
      const result = await runAction(createCostClass(newClassName.trim()), { errorTitle: 'Couldn’t add class' });
      if (!result.ok) return;
      const created = result.data;
      if (created) {
        setClassList([...classList, { id: created.id, name: created.name }]);
        setForm((f) => ({ ...f, classId: created.id }));
        setNewClassName('');
        notifications.show({ title: 'Class added', message: created.name, color: 'success' });
      }
    });
  }

  const selectedContract = contracts.find((c) => c.id === form.contractId);
  const clinOptions = selectedContract?.clins.map((cl) => ({
    value: cl.id, label: `${cl.clinNumber}${cl.description ? ` — ${cl.description}` : ''}`,
  })) ?? [];

  const columns: MRT_ColumnDef<ChargeCodeRow>[] = [
    { accessorKey: 'code', header: 'Code', size: 160 },
    { accessorKey: 'name', header: 'Name', size: 200 },
    {
      id: 'contract',
      header: 'Contract / CLIN',
      accessorFn: (r) => `${r.contractNumber} / ${r.clinNumber}`,
      size: 180,
    },
    {
      accessorKey: 'className',
      header: 'Class',
      Cell: ({ cell }) => cell.getValue() ? <Badge color="gray">{cell.getValue<string>()}</Badge> : null,
    },
    {
      accessorKey: 'workLocation',
      header: 'Location',
      Cell: ({ cell }) => {
        const loc = cell.getValue<string | null>();
        return loc ? <Badge color={WORK_LOCATION_COLOR[loc] ?? 'gray'}>{loc}</Badge> : null;
      },
    },
    {
      accessorKey: 'isActive',
      header: 'Active',
      Cell: ({ cell }) => {
        const active = cell.getValue<boolean>();
        return (
          <Badge color={active ? RECORD_STATUS_COLOR.active : RECORD_STATUS_COLOR.inactive}>
            {active ? 'Active' : 'Inactive'}
          </Badge>
        );
      },
    },
  ];

  const table = useAppTable({
    columns, data: codes,
    enableRowActions: true,
    renderRowActions: ({ row }) => {
      const code = row.original;
      return (
        <RowActions
          rowLabel={code.code}
          primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEdit(code) }}
          items={[
            { key: 'category', label: 'Change labor category', icon: 'laborCategory', onSelect: () => setCategoryFor(code) },
            code.isActive
              ? { key: 'deactivate', label: 'Deactivate…', icon: 'deactivate', tone: 'danger', onSelect: () => setConfirmTarget(code) }
              : { key: 'reactivate', label: 'Reactivate…', icon: 'reactivate', busy: busyRows.isBusy(code.id), onSelect: () => openReactivate(code) },
          ]}
        />
      );
    },
  });

  return (
    <>
      <PageHeader
        title="Charge Codes"
        description={'Direct charge codes that employees charge to. Each code rolls up to a CLIN → Contract. Use "Auto-generate from CLINs" to create one code per active CLIN, or create custom codes (e.g. Onsite/Telework variants).'}
        actions={
          <Group gap="sm">
            <WriteButton leftSection={<Icons.create size={ICON_SIZE.button} />} onClick={openCreate} size="sm">New Charge Code</WriteButton>
            <WriteButton leftSection={<Icons.automate size={ICON_SIZE.button} />} variant="default" onClick={handleAutobridge} loading={isPending} size="sm">
              Auto-generate from CLINs
            </WriteButton>
          </Group>
        }
      />
      <Stack gap="md">
        <MantineReactTable table={table} />
      </Stack>

      <Modal opened={modalOpen} onClose={() => setModalOpen(false)} title={editingId ? 'Edit Charge Code' : 'New Charge Code'} size="lg">
        <Stack gap="md">
          <TextInput label="Code" placeholder="G0490.ID.IaaS.OY7.SWE3" required
            value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
          <TextInput label="Name" placeholder="Human-readable label" required
            value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <Textarea label="Description" placeholder="Optional description"
            value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />

          <Select label="Contract" placeholder="Select contract" required
            data={contracts.map((c) => ({ value: c.id, label: `${c.contractNumber} — ${c.name}` }))}
            value={form.contractId} onChange={(v) => setForm((f) => ({ ...f, contractId: v ?? '', clinId: '' }))} />

          <Select label="CLIN" placeholder="Select CLIN" required
            data={clinOptions} value={form.clinId}
            onChange={(v) => setForm((f) => ({ ...f, clinId: v ?? '' }))}
            disabled={!form.contractId} />

          <Select label="Work Location" placeholder="Not specified"
            data={WORK_LOCATION_OPTIONS} value={form.workLocation}
            onChange={(v) => setForm((f) => ({ ...f, workLocation: v ?? '' }))} />

          <Group align="flex-end">
            <Select label="Class (optional)" placeholder="Select class" clearable
              data={classList.map((c) => ({ value: c.id, label: c.name }))}
              value={form.classId || null} onChange={(v) => setForm((f) => ({ ...f, classId: v ?? '' }))}
              style={{ flex: 1 }} />
            <TextInput placeholder="New class name" value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)} style={{ flex: 1 }} />
            <WriteButton variant="default" onClick={handleAddClass} loading={isPending}>Add</WriteButton>
          </Group>

          <Switch label="Billable" checked={form.billable}
            onChange={(e) => setForm((f) => ({ ...f, billable: e.target.checked }))} />

          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpen(false)}>Cancel</Button>
            <WriteButton onClick={handleSave} loading={isPending}>Save</WriteButton>
          </Group>
        </Stack>
      </Modal>

      <ChargeCodeCategoryModal
        opened={!!categoryFor}
        onClose={() => setCategoryFor(null)}
        code={categoryFor ? { id: categoryFor.id, code: categoryFor.code, clinId: categoryFor.clinId, slinId: categoryFor.slinId, schedule: { starting: categoryFor.laborCategoryId, changes: categoryFor.categoryChanges ?? [] } } : null}
        categories={laborCategories}
        canWrite={canWrite}
        onSaved={mergeCategorySchedule}
      />

      <ConfirmModal
        opened={!!confirmTarget}
        title="Deactivate charge code?"
        message={confirmTarget ? `This deactivates ${confirmTarget.code} — ${confirmTarget.name}. Existing timesheet history is preserved.` : ''}
        confirmLabel="Deactivate"
        loading={isPending}
        onConfirm={() => confirmTarget && handleDeactivate(confirmTarget.id, confirmTarget.code)}
        onCancel={() => setConfirmTarget(null)}
      />

      <ConfirmModal
        opened={!!reactivateTarget}
        tone="neutral"
        title="Reactivate charge code?"
        message={reactivateTarget
          ? `${reactivateTarget.stillAssigned} ${reactivateTarget.stillAssigned === 1 ? 'employee is' : 'employees are'} still assigned and will see this code again.`
            + (reactivateTarget.assignable ? '' : ' Its CLIN, SLIN or contract is inactive, so it can’t be used for new hours until they’re all active again.')
          : ''}
        confirmLabel="Reactivate"
        loading={isPending}
        onConfirm={() => reactivateTarget && handleReactivate(reactivateTarget.row.id, reactivateTarget.row.code)}
        onCancel={() => setReactivateTarget(null)}
      />
    </>
  );
}
