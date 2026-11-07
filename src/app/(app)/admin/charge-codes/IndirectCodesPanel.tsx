'use client';

import { useEffect, useImperativeHandle, useMemo, useState, type Ref } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Switch, Text, TextInput, Textarea, Loader } from '@mantine/core';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { runAction } from '@/lib/run-action';
import { toastSuccess } from '@/lib/toast';
import { notifications } from '@mantine/notifications';
import { addedStandardCodes } from '@/lib/ui/indirect-seed-copy';
import { RowActions } from '@/components/ui/RowActions';
import { useBusyRows, useLastTarget } from '@/components/ui/useRowState';
import { useBusy } from '@/components/ui/useBusy';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Notice } from '@/components/ui/Notice';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAppTable, type AppTableExpandable } from '@/components/table/mrtDefaults';
import { createIndirectCode, updateIndirectCode, getIndirectChargeCodes, seedIndirectCodes } from '@/server/actions/indirect-codes';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { formatCount } from '@/lib/format';
import classes from './ChargeCodes.module.css';

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

/** §3.5: the groups, in order, with their sub-lines. */
const GROUPS: Array<{ category: IndirectCode['category']; label: string; sub?: string }> = [
  { category: 'leave', label: 'Leave', sub: 'paid and unpaid time off' },
  { category: 'overhead', label: 'Overhead' },
  { category: 'ga', label: 'G&A', sub: 'general and administrative' },
  { category: 'irad', label: 'IR&D' },
  { category: 'bp', label: 'B&P' },
  { category: 'unallowable', label: 'Unallowable', sub: 'FAR 31.205' },
];

/** certified-outputs C7 (CO-D11): how a leave code's hours are paid; required for leave codes. */
const LEAVE_PAY_TYPE_OPTIONS = [
  { value: 'pto', label: 'Paid time off' },
  { value: 'sick', label: 'Sick' },
  { value: 'holiday', label: 'Holiday' },
  { value: 'unpaid', label: 'Unpaid' },
];
const LEAVE_PAY_TYPE_LABELS: Record<string, string> = Object.fromEntries(LEAVE_PAY_TYPE_OPTIONS.map((o) => [o.value, o.label]));

type CodeForm = {
  code: string;
  name: string;
  category: string;
  description: string;
  availableToAll: boolean;
  leavePayType: string | null;
};
type FormErrors = Partial<Record<'code' | 'name' | 'payType', string>>;

const EMPTY_FORM: CodeForm = {
  code: '',
  name: '',
  category: 'overhead',
  description: '',
  availableToAll: true,
  leavePayType: null,
};

type StatusFilter = 'active' | 'inactive' | 'all';
type Row =
  | { level: 'group'; id: string; label: string; sub?: string; children: Row[] }
  | { level: 'code'; id: string; code: IndirectCode };

const onTimesheets = (c: IndirectCode) => (!c.isActive ? '—' : c.availableToAll ? 'Everyone' : 'Hidden');
const statusWord = (c: IndirectCode) => (c.isActive ? 'Active' : 'Inactive');

/** §3.5: every leave code — active or not, as payroll-data.ts blocks on any — with no pay type, by code. */
export function leaveCodesWithoutPayType(codes: IndirectCode[]): IndirectCode[] {
  return codes.filter((c) => c.category === 'leave' && !c.leavePayType).sort((a, b) => a.code.localeCompare(b.code));
}

export function IndirectCodesPanel({ initialCodes, ref, onCountChange }: Props) {
  // Deactivate asks first (feature-plan-ux-foundations.md §4.5, B2); Reactivate runs directly with a row loader.
  const [confirmDeactivate, setConfirmDeactivate] = useState<IndirectCode | null>(null);
  const busyRows = useBusyRows();
  const busy = useBusy();
  const shownDeactivate = useLastTarget(confirmDeactivate); // kept while the modal animates closed
  const [codes, setCodes] = useState<IndirectCode[]>(initialCodes);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCode, setEditingCode] = useState<IndirectCode | null>(null);
  const [form, setForm] = useState<CodeForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  // C2: turning "Show on every timesheet" off asks first; the form's own error shows inside this confirm while it's open.
  const [hideConfirm, setHideConfirm] = useState(false);

  function openCreateModal() {
    setEditingCode(null);
    setForm(EMPTY_FORM);
    setErrors({});
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
    setErrors({});
    setFormError(null);
    setModalOpen(true);
  }

  /** `confirmed`: the hide confirm was accepted (feature-plan-ux-page-fixes.md C2). Wired as `() => handleSubmit()`. */
  async function handleSubmit({ confirmed = false }: { confirmed?: boolean } = {}) {
    setFormError(null);
    // §3.5: inline errors next to the fields, validated on click.
    const next: FormErrors = {};
    if (!form.code.trim()) next.code = 'Enter a code.';
    if (!form.name.trim()) next.name = 'Enter a name.';
    if (form.category === 'leave' && !form.leavePayType) next.payType = 'Choose a pay type for a leave code — payroll export needs it.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (editingCode?.availableToAll && !form.availableToAll && !confirmed) {
      setHideConfirm(true);
      return;
    }
    await busy.run('save', async () => {
      const fields = {
        code: form.code,
        name: form.name,
        category: form.category as IndirectCode['category'],
        description: form.description || undefined,
        availableToAll: form.availableToAll,
        leavePayType: form.category === 'leave' ? (form.leavePayType as 'pto' | 'sick' | 'holiday' | 'unpaid' | null) : null,
      };
      // silent: the error is shown inside the form (or the hide confirm).
      const result = editingCode
        ? await runAction(updateIndirectCode(editingCode.id, fields), { silent: true })
        : await runAction(createIndirectCode(fields), { silent: true });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setHideConfirm(false);
      toastSuccess({ title: editingCode ? 'Indirect code updated' : 'Indirect code added', message: form.code.trim() });
      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      setModalOpen(false);
    });
  }

  /** Same server call as before; the confirm closes only on success (onDone). */
  async function handleToggleActive(code: IndirectCode, onDone?: () => void) {
    if (!onDone) busyRows.start(code.id);
    setDeactivateError(null);
    await busy.run(`toggle:${code.id}`, async () => {
      const result = await runAction(updateIndirectCode(code.id, { isActive: !code.isActive }), onDone ? { silent: true } : { errorTitle: 'Couldn’t update code' });
      busyRows.done(code.id);
      if (!result.ok) { if (onDone) setDeactivateError(result.error); return; }
      onDone?.();
      const refreshed = await getIndirectChargeCodes();
      setCodes(refreshed as IndirectCode[]);
      toastSuccess({ title: code.isActive ? 'Deactivated' : 'Reactivated', message: `${code.code} is now ${code.isActive ? 'inactive' : 'active'}.` });
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

  const rows = useMemo<Row[]>(() => GROUPS
    .map((g): Row => ({
      level: 'group', id: g.category, label: g.label, sub: g.sub,
      children: codes
        .filter((c) => c.category === g.category && (status === 'all' || (status === 'active') === c.isActive))
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((c): Row => ({ level: 'code', id: c.id, code: c })),
    }))
    .filter((g) => g.level === 'group' && g.children.length > 0), [codes, status]); // empty groups hidden

  const columns = useMemo<MRT_ColumnDef<Row>[]>(() => [
    {
      id: 'code', header: 'Code', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level === 'group'
        ? <span className={classes.oneLine}><Text fw={600} span>{r.label}</Text>{r.sub && <span className={classes.dim}> · {r.sub}</span>}</span>
        : <span className={classes.mono}>{r.code.code}</span>),
    },
    { id: 'name', header: 'Name', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'code' ? r.code.name : null) },
    {
      id: 'payType', header: 'Pay type', enableSorting: false,
      Cell: ({ row: { original: r } }) => {
        if (r.level !== 'code') return null;
        if (r.code.category !== 'leave') return <span className={classes.dim}>—</span>;
        return r.code.leavePayType ? LEAVE_PAY_TYPE_LABELS[r.code.leavePayType] ?? r.code.leavePayType : <StatusBadge word="Not set" tone="bad" />;
      },
    },
    {
      id: 'onTimesheets', header: 'On timesheets', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level === 'code'
        ? <span className={onTimesheets(r.code) === 'Everyone' ? undefined : classes.dim}>{onTimesheets(r.code)}</span>
        : null),
    },
    { id: 'status', header: 'Status', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'code' ? <StatusBadge status={r.code.isActive ? 'active' : 'inactive'} /> : null) },
  ], []);

  const expandable = useMemo<AppTableExpandable<Row>>(() => ({
    getSubRows: (r) => (r.level === 'group' ? r.children : undefined),
    label: (r) => (r.level === 'group' ? `${r.label} codes` : r.code.code),
    // The words, so the search finds "Inactive" and "Hidden" (UX-1 audit L3, C2).
    searchText: (r) => (r.level === 'group' ? r.label : `${r.code.code} ${r.code.name} ${statusWord(r.code)} ${onTimesheets(r.code)}`),
    rowId: (r) => `${r.level}:${r.id}`,
    defaultExpanded: true,
  }), []);

  const table = useAppTable<Row>({
    columns,
    data: rows,
    expandable,
    hairline: true,
    compact: true,
    enableRowActions: true,
    renderRowActions: ({ row: { original: r } }) => {
      if (r.level !== 'code') return null;
      const code = r.code;
      return (
        <RowActions
          rowLabel={code.code}
          primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEditModal(code) }}
          items={[
            code.isActive
              ? { key: 'deactivate', label: 'Deactivate…', icon: 'deactivate', tone: 'danger', onSelect: () => { setDeactivateError(null); setConfirmDeactivate(code); } }
              : { key: 'reactivate', label: 'Reactivate', icon: 'reactivate', busy: busyRows.isBusy(code.id), onSelect: () => { void handleToggleActive(code); } },
          ]}
        />
      );
    },
    emptyState: { title: 'No indirect codes match.' },
  });

  const missingPayType = leaveCodesWithoutPayType(codes);

  if (codes.length === 0) {
    // C3 / §3.5: the standard-codes offer lives in the empty state of a workspace with NO codes.
    return (
      <>
        <Stack align="center" gap={6} py="xl" data-testid="indirect-empty">
          <Text fw={600}>No indirect codes yet.</Text>
          <Text size="sm" c="dimmed">Add the standard DCAA set or add your own.</Text>
          <WriteButton
            variant="default"
            mt="xs"
            onClick={handleSeedDefaults}
            aria-disabled={seeding || undefined}
            leftSection={seeding ? <Loader size={14} aria-hidden="true" /> : undefined}
          >
            Add standard codes
          </WriteButton>
        </Stack>
        {formModal()}
      </>
    );
  }

  function formModal() {
    return (
      <Modal
        opened={modalOpen}
        onClose={() => { if (!busy.is('save')) setModalOpen(false); }}
        // Every open modal listens for Esc on window: with the hide confirm open, Esc must close only the confirm.
        closeOnEscape={!hideConfirm}
        title={editingCode ? 'Edit indirect code' : 'Add indirect code'}
        size="md"
      >
        <Stack>
          {/* While the hide confirm is open its error shows there instead (one error location). */}
          {formError && !hideConfirm && <Alert color="red" role="alert" data-testid="indirect-form-error">{formError}</Alert>}
          <TextInput
            label="Code"
            placeholder="e.g., OH-001, LV-AL"
            required
            error={errors.code}
            value={form.code}
            onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, code: v })); }}
          />
          <TextInput
            label="Name"
            placeholder="e.g., Overhead, Annual Leave"
            required
            error={errors.name}
            value={form.name}
            onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, name: v })); }}
          />
          <Select
            label="Category"
            data={CATEGORY_OPTIONS}
            value={form.category}
            allowDeselect={false}
            onChange={(val) => setForm((f) => ({ ...f, category: val ?? 'overhead' }))}
            required
          />
          {form.category === 'leave' && (
            <Select
              label="Pay type"
              description="How these hours are paid in the payroll export (its own column; unpaid is never paid)."
              data={LEAVE_PAY_TYPE_OPTIONS}
              value={form.leavePayType}
              error={errors.payType}
              onChange={(val) => setForm((f) => ({ ...f, leavePayType: val }))}
              required
              data-testid="leave-pay-type"
            />
          )}
          <Textarea
            label="Description"
            placeholder="Optional description"
            value={form.description}
            onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, description: v })); }}
            minRows={2}
          />
          <Switch
            label="Show on every timesheet"
            description="When off, employees can't add this code or record new hours on it. Where hours are already recorded, the row stays in that period for corrections and notes."
            checked={form.availableToAll}
            onChange={(e) => { const checked = e.currentTarget.checked; setForm((f) => ({ ...f, availableToAll: checked })); }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { if (!busy.is('save')) setModalOpen(false); }}>Cancel</Button>
            <WriteButton {...busy.props('save')} onClick={() => { void handleSubmit(); }}>
              {editingCode ? 'Save Changes' : 'Create Code'}
            </WriteButton>
          </Group>
        </Stack>
      </Modal>
    );
  }

  return (
    <>
      <Stack gap="sm">
        {missingPayType.length > 0 && (
          <div data-testid="pay-type-notice">
            <Notice action={{ label: 'Set pay type', onClick: () => openEditModal(missingPayType[0]) }}>
              {missingPayType.length === 1
                ? <><b>{missingPayType[0].code} {missingPayType[0].name} has no pay type,</b> so Payroll export is blocked for anyone who charged it.</>
                : <><b>{formatCount(missingPayType.length)} leave codes have no pay type,</b> so Payroll export is blocked for anyone who charged them.</>}
            </Notice>
          </div>
        )}
        <Group gap="md" align="flex-end">
          <Select
            label="Status" w={160} allowDeselect={false}
            data={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }]}
            value={status} onChange={(v) => setStatus((v as StatusFilter) ?? 'active')}
          />
        </Group>
        <MantineReactTable table={table} />
      </Stack>

      <ConfirmModal
        opened={!!confirmDeactivate}
        title={`Deactivate ${shownDeactivate?.code ?? ''}?`}
        message="Employees can't charge new time to it. Existing hours stay on record."
        confirmLabel="Deactivate"
        loading={confirmDeactivate ? busy.is(`toggle:${confirmDeactivate.id}`) : false}
        error={deactivateError}
        onConfirm={() => { if (confirmDeactivate) void handleToggleActive(confirmDeactivate, () => setConfirmDeactivate(null)); }}
        onCancel={() => setConfirmDeactivate(null)}
      />

      <ConfirmModal
        opened={hideConfirm}
        tone="danger"
        title={`Hide ${form.code} from timesheets?`}
        message={`Employees won't be able to add ${form.code} or record new hours on it. Rows that already have hours stay visible in their period for corrections and notes.`}
        confirmLabel="Hide code"
        loading={busy.is('save')}
        error={formError}
        onConfirm={() => { void handleSubmit({ confirmed: true }); }}
        onCancel={() => { setHideConfirm(false); setFormError(null); }}
      />

      {formModal()}
    </>
  );
}
