'use client';

import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Alert, Button, Group, Modal, Select, Stack, Switch, Tabs, Text, TextInput, Textarea,
} from '@mantine/core';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { runAction } from '@/lib/run-action';
import { toastError, toastSuccess } from '@/lib/toast';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { RowActions } from '@/components/ui/RowActions';
import { useBusyRows } from '@/components/ui/useRowState';
import { useBusy } from '@/components/ui/useBusy';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAppTable, numericColumn, type AppTableExpandable } from '@/components/table/mrtDefaults';
import {
  createChargeCode, updateChargeCode, deactivateChargeCode, reactivateChargeCode, getChargeCodeReactivationInfo,
  createCostClass, listChargeCodes,
} from '@/server/actions/charge-codes';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';
import { ChargeCodeCategoryModal, type CategoryOption } from './ChargeCodeCategoryModal';
import { CreateFromClinsModal } from './CreateFromClinsModal';
import { IndirectCodesPanel, type IndirectCode, type IndirectPanelHandle } from './IndirectCodesPanel';
import { chargeCodeCategoryOn, type CategoryChange, type CategoryScheduleView } from '@/lib/labor-rates';
import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { formatCount } from '@/lib/format';
import { parseCodesTab, type CodesTab } from '@/lib/charge-codes-tab';
import classes from './ChargeCodes.module.css';

type ChargeCodeRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  clinId: string;
  clinNumber: string;
  /** feature-plan-ux-people-codes.md §3.2. */
  clinDescription?: string | null;
  slinId: string | null;
  slinNumber?: string | null;
  chargeable?: boolean;
  peopleCount?: number;
  contractId?: string;
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
  /** The code has recorded hours, so its CLIN and SLIN can't change (feature-plan-ux-page-fixes.md C5). */
  hasHours: boolean;
};

/** The Contract Select's option for an edited code's own CLIN when that CLIN (or its contract) is inactive (C5). */
const CURRENT_PAIR = '__current__';

type ClinOption = { id: string; clinNumber: string; description: string | null };
type ContractOption = { id: string; name: string; contractNumber: string; clins: ClinOption[] };
type SlinOption = { id: string; clinId: string; slinNumber: string; description: string | null };

type Props = {
  initialTab?: CodesTab;
  initialCodes: ChargeCodeRow[];
  costClasses: Array<{ id: string; name: string }>;
  /** ACTIVE contracts with their ACTIVE CLINs (the picker, and the empty-CLIN lines). */
  contracts: ContractOption[];
  /** Active SLINs (§3.4). */
  slins?: SlinOption[];
  laborCategories: CategoryOption[];
  indirectCodes?: IndirectCode[];
  workspaceToday?: CalendarDate;
  /** feature-plan-ux-kit-contracts.md §4.4.7: open this code's labor-category dialog on load (the Unpriced report's fix). */
  openCategoryForId?: string;
};

type CodeForm = {
  code: string;
  name: string;
  description: string;
  contractId: string;
  clinId: string;
  slinId: string;
  classId: string;
  workLocation: string;
  billable: boolean;
};
type FormErrors = Partial<Record<'code' | 'name' | 'clin', string>>;

const EMPTY_FORM: CodeForm = {
  code: '', name: '', description: '',
  contractId: '', clinId: '', slinId: '', classId: '',
  workLocation: '', billable: true,
};

const WORK_LOCATION_OPTIONS = [
  { value: '', label: 'Not specified' },
  { value: 'onsite', label: 'Onsite' },
  { value: 'telework', label: 'Telework' },
  { value: 'other', label: 'Other' },
];
const LOCATION_WORD: Record<string, string> = { onsite: 'Onsite', telework: 'Telework', other: 'Other' };

type StatusFilter = 'active' | 'inactive' | 'all';

/** A row of the Direct table: a contract, one of its codes, or one of its active CLINs with no code (§3.2). */
type TreeRow =
  | { level: 'contract'; id: string; name: string; number: string; children: TreeRow[] }
  | { level: 'code'; id: string; code: ChargeCodeRow }
  | { level: 'empty'; id: string; clinNumber: string; clinDescription: string | null };

/**
 * The Direct tab's rows (§3.2): contracts (by name) → their codes (by code) for the status filter, then — only while
 * the filter is Active — each active CLIN that no code (active or not) uses. A contract with only those lines is still a
 * parent. Exported for tests.
 */
export function directRows(codes: ChargeCodeRow[], contracts: ContractOption[], status: StatusFilter): TreeRow[] {
  const groups = new Map<string, { name: string; number: string; codes: ChargeCodeRow[]; empty: ClinOption[] }>();
  const group = (key: string, name: string, number: string) => {
    let g = groups.get(key);
    if (!g) { g = { name, number, codes: [], empty: [] }; groups.set(key, g); }
    return g;
  };
  for (const c of codes) {
    if (status === 'active' && !c.isActive) continue;
    if (status === 'inactive' && c.isActive) continue;
    group(c.contractId ?? c.contractNumber, c.contractName, c.contractNumber).codes.push(c);
  }
  if (status === 'active') {
    const used = new Set(codes.map((c) => c.clinId));
    for (const k of contracts) {
      for (const cl of k.clins) if (!used.has(cl.id)) group(k.id, k.name, k.contractNumber).empty.push(cl);
    }
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([key, g]) => ({
      level: 'contract' as const, id: key, name: g.name, number: g.number,
      children: [
        ...[...g.codes].sort((a, b) => a.code.localeCompare(b.code)).map((code): TreeRow => ({ level: 'code', id: code.id, code })),
        ...g.empty.map((cl): TreeRow => ({ level: 'empty', id: cl.id, clinNumber: cl.clinNumber, clinDescription: cl.description })),
      ],
    }));
}

const emptyLineText = (r: { clinNumber: string; clinDescription: string | null }) =>
  `CLIN ${r.clinNumber}${r.clinDescription ? ` ${r.clinDescription}` : ''} has no charge codes.`;

export function ChargeCodesClient({
  initialTab = 'direct', initialCodes, costClasses, contracts, slins = [], laborCategories, indirectCodes = [], workspaceToday, openCategoryForId,
}: Props) {
  const canWrite = useCanWrite();
  // R1, §3.1: the tab lives in the URL; the client follows useSearchParams (switching uses history.replaceState).
  const searchParams = useSearchParams();
  const tab: CodesTab = searchParams ? parseCodesTab(searchParams.get('tab')) : initialTab;
  function switchTab(value: string | null) {
    const next = parseCodesTab(value);
    if (next === tab) return;
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('tab', next);
    if (next !== 'direct') params.delete('code'); // ?code= belongs to the Direct tab only
    window.history.replaceState(null, '', `?${params.toString()}`);
  }
  const indirectRef = useRef<IndirectPanelHandle>(null);
  const [indirectCount, setIndirectCount] = useState(indirectCodes.length);

  const [codes, setCodes] = useState(initialCodes);
  const [status, setStatus] = useState<StatusFilter>('active');
  // Dated rates D3: the "Labor category" modal; a saved schedule is merged back into the table's rows.
  const [categoryFor, setCategoryFor] = useState<ChargeCodeRow | null>(() => (openCategoryForId ? initialCodes.find((c) => c.id === openCategoryForId) ?? null : null));
  function mergeCategorySchedule(view: CategoryScheduleView) {
    setCodes((prev) => prev.map((c) => (c.id === view.chargeCodeId ? { ...c, laborCategoryId: view.starting, categoryChanges: view.changes } : c)));
  }
  const busy = useBusy();
  const [modalOpen, setModalOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<ChargeCodeRow | null>(null);
  const editingId = editingRow?.id ?? null;
  const [form, setForm] = useState<CodeForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [newClassName, setNewClassName] = useState('');
  const [classList, setClassList] = useState(costClasses);
  const [confirmTarget, setConfirmTarget] = useState<ChargeCodeRow | null>(null);
  // certified-outputs C3 (CO-D8, ruling Q2): reactivation confirm — how many employees get the code back.
  // Reactivate fetches the code's info before its confirm opens: a loader on that row meanwhile.
  const busyRows = useBusyRows();
  const [reactivateTarget, setReactivateTarget] = useState<{ row: ChargeCodeRow; stillAssigned: number; assignable: boolean } | null>(null);

  /** §3.2: after every write, refetch into state (router.refresh alone doesn't update this table). */
  async function refreshCodes() {
    const fresh = await listChargeCodes();
    setCodes(fresh as ChargeCodeRow[]);
  }

  function openCreate() {
    setEditingRow(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setServerError(null);
    setModalOpen(true);
  }

  function openEdit(row: ChargeCodeRow) {
    // The page lists only ACTIVE contract + CLIN pairs: a code on an inactive CLIN gets its pair as an extra option.
    const contract = contracts.find((c) => c.clins.some((cl) => cl.id === row.clinId));
    setEditingRow(row);
    setForm({
      code: row.code,
      name: row.name,
      description: row.description ?? '',
      contractId: contract?.id ?? CURRENT_PAIR,
      clinId: row.clinId,
      slinId: row.slinId ?? '',
      classId: row.classId ?? '',
      workLocation: row.workLocation ?? '',
      billable: row.billable,
    });
    setErrors({});
    setServerError(null);
    setModalOpen(true);
  }

  async function handleSave() {
    // §3.4: validate on click; field errors inline. A CLIN is required on create, and on edit once the contract changed.
    const next: FormErrors = {};
    if (!form.code.trim()) next.code = 'Enter a code.';
    if (!form.name.trim()) next.name = 'Enter a name.';
    if (!form.clinId) next.clin = 'Choose a CLIN.';
    setErrors(next);
    setServerError(null);
    if (Object.keys(next).length > 0) return;
    // Edit: send clinId / slinId only when they changed — the server refuses a move once hours or categories exist.
    const clinChange = editingRow && form.clinId !== editingRow.clinId ? { clinId: form.clinId } : {};
    const slinChange = editingRow && (form.slinId || null) !== editingRow.slinId ? { slinId: form.slinId || null } : {};
    await busy.run('save', async () => {
      // silent: server errors go in the form's Alert, never a toast (§3.4).
      const result = editingId
        ? await runAction(updateChargeCode(editingId, {
            code: form.code.trim(), name: form.name.trim(),
            description: form.description || undefined,
            ...clinChange, ...slinChange, classId: form.classId || null,
            workLocation: (form.workLocation as 'onsite' | 'telework' | 'other') || null,
            billable: form.billable,
          }), { silent: true })
        : await runAction(createChargeCode({
            code: form.code.trim(), name: form.name.trim(),
            description: form.description || undefined,
            clinId: form.clinId, slinId: form.slinId || undefined, classId: form.classId || undefined,
            workLocation: (form.workLocation as 'onsite' | 'telework' | 'other') || undefined,
            billable: form.billable,
          }), { silent: true });
      if (!result.ok) { setServerError(result.error); return; } // the form stays open with the user's input
      toastSuccess({ title: editingId ? 'Charge code updated' : 'Charge code added', message: form.code.trim() });
      setModalOpen(false);
      await refreshCodes();
    });
  }

  async function handleDeactivate(id: string, code: string) {
    await busy.run('deactivate', async () => {
      const result = await runAction(deactivateChargeCode(id), { errorTitle: 'Couldn’t deactivate' });
      if (!result.ok) return;
      toastSuccess({ title: 'Deactivated', message: `${code} deactivated.` });
      setConfirmTarget(null);
      await refreshCodes();
    });
  }

  function openReactivate(row: ChargeCodeRow) {
    busyRows.start(row.id);
    void (async () => {
      try {
        const info = await getChargeCodeReactivationInfo(row.id);
        setReactivateTarget({ row, ...info });
      } catch {
        toastError({ title: 'Couldn’t load the charge code', message: 'Refresh the page and try again.' });
      } finally {
        busyRows.done(row.id);
      }
    })();
  }

  async function handleReactivate(id: string, code: string) {
    await busy.run('reactivate', async () => {
      const result = await runAction(reactivateChargeCode(id), { errorTitle: 'Couldn’t reactivate' });
      if (!result.ok) return;
      toastSuccess({ title: 'Reactivated', message: `${code} reactivated.` });
      setReactivateTarget(null);
      await refreshCodes();
    });
  }

  async function handleAddClass() {
    if (!newClassName.trim()) return;
    await busy.run('class', async () => {
      const result = await runAction(createCostClass(newClassName.trim()), { errorTitle: 'Couldn’t add class' });
      if (!result.ok) return;
      const created = result.data;
      if (created) {
        setClassList([...classList, { id: created.id, name: created.name }]);
        setForm((f) => ({ ...f, classId: created.id }));
        setNewClassName('');
      }
    });
  }

  // C5 + §3.4: what the edit form may do with the code's CLIN and SLIN (the same lock covers both).
  const editClinActive = !editingRow || contracts.some((c) => c.clins.some((cl) => cl.id === editingRow.clinId));
  const lockReason: 'hours' | 'categories' | null = !editingRow ? null
    : editingRow.hasHours ? 'hours'
      : (editingRow.laborCategoryId || editingRow.categoryChanges?.length) ? 'categories' : null;
  const contractOptions = [
    ...(editingRow && !editClinActive && !lockReason
      ? [{ value: CURRENT_PAIR, label: `${editingRow.contractNumber} · CLIN ${editingRow.clinNumber} (inactive)` }] : []),
    ...contracts.map((c) => ({ value: c.id, label: `${c.contractNumber} — ${c.name}` })),
  ];
  const selectedContract = contracts.find((c) => c.id === form.contractId);
  const clinOptions = form.contractId === CURRENT_PAIR && editingRow
    ? [{ value: editingRow.clinId, label: `${editingRow.clinNumber} (inactive)` }]
    : selectedContract?.clins.map((cl) => ({
      value: cl.id, label: `${cl.clinNumber}${cl.description ? ` — ${cl.description}` : ''}`,
    })) ?? [];
  // §3.4: "None", the CLIN's active SLINs, and always the code's own SLIN (labelled "(inactive)" when it is).
  const slinOptions = [
    { value: '', label: 'None' },
    ...slins.filter((sl) => sl.clinId === form.clinId).map((sl) => ({ value: sl.id, label: `${sl.slinNumber}${sl.description ? ` — ${sl.description}` : ''}` })),
    ...(editingRow?.slinId && form.clinId === editingRow.clinId && !slins.some((sl) => sl.id === editingRow.slinId)
      ? [{ value: editingRow.slinId, label: `${editingRow.slinNumber ?? 'SLIN'} (inactive)` }] : []),
  ];

  const nameOf = useMemo(() => new Map(laborCategories.map((lc) => [lc.id, lc.lcatCode])), [laborCategories]);
  const rows = useMemo(() => directRows(codes, contracts, status), [codes, contracts, status]);

  const columns = useMemo<MRT_ColumnDef<TreeRow>[]>(() => [
    {
      id: 'code', header: 'Charge code', enableSorting: false,
      Cell: ({ row: { original: r } }) => {
        if (r.level === 'contract') {
          return <span className={classes.oneLine}><Text fw={600} span>{r.name}</Text> <span className={`${classes.mono} ${classes.dim}`}>{r.number}</span></span>;
        }
        if (r.level === 'empty') return <span className={classes.dim} data-testid="empty-clin-line">{emptyLineText(r)}</span>;
        const c = r.code;
        return (
          <>
            <span className={classes.mono}>{c.code}</span>
            <span className={classes.sub}>CLIN {c.clinNumber}{c.slinNumber ? ` · SLIN ${c.slinNumber}` : ''}</span>
          </>
        );
      },
    },
    { id: 'name', header: 'Name', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'code' ? r.code.name : null) },
    {
      id: 'category', header: 'Labor category', enableSorting: false,
      // §3.2 / CC-3: the category in effect on the workspace's today (a future-dated change isn't shown yet).
      Cell: ({ row: { original: r } }) => {
        if (r.level !== 'code' || !workspaceToday) return null;
        const c = r.code;
        const on = chargeCodeCategoryOn({ starting: c.laborCategoryId, changes: c.categoryChanges ?? [] }, workspaceToday);
        if (!on.laborCategoryId) return <span className={classes.dim}>None</span>;
        const since = on.source === 'starting' ? null : c.categoryChanges.find((ch) => ch.id === on.source)?.effectiveDate ?? null;
        return (
          <span data-testid="code-category">
            <span className={classes.mono}>{nameOf.get(on.laborCategoryId) ?? 'Unknown'}</span>
            {since && <span className={classes.dim}> since {formatCalendarDate(since, 'MMM D, YYYY')}</span>}
          </span>
        );
      },
    },
    { id: 'location', header: 'Location', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'code' ? LOCATION_WORD[r.code.workLocation ?? ''] ?? '—' : null) },
    { id: 'billable', header: 'Billable', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'code' ? (r.code.billable ? 'Yes' : 'No') : null) },
    numericColumn<TreeRow>({
      id: 'people', header: 'People', enableSorting: false,
      Cell: ({ row: { original: r } }) => {
        if (r.level !== 'code') return null;
        const n = r.code.peopleCount ?? 0;
        return <span className={n === 0 ? classes.warn : undefined}>{formatCount(n)}</span>;
      },
    }),
    { id: 'status', header: 'Status', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'code' ? <StatusBadge status={r.code.isActive ? 'active' : 'inactive'} /> : null) },
  ], [nameOf, workspaceToday]);

  const expandable = useMemo<AppTableExpandable<TreeRow>>(() => ({
    getSubRows: (r) => (r.level === 'contract' ? r.children : undefined),
    label: (r) => (r.level === 'contract' ? `codes for ${r.name}` : r.level === 'code' ? r.code.code : emptyLineText(r)),
    searchText: (r) => (r.level === 'contract' ? `${r.name} ${r.number}` : r.level === 'code' ? `${r.code.code} ${r.code.name}` : emptyLineText(r)),
    rowId: (r) => `${r.level}:${r.id}`,
    defaultExpanded: true,
  }), []);

  const table = useAppTable<TreeRow>({
    columns,
    data: rows,
    expandable,
    hairline: true,
    compact: rows.length <= 25,
    enableRowActions: true,
    renderRowActions: ({ row: { original: r } }) => {
      if (r.level !== 'code') return null;
      const code = r.code;
      return (
        <RowActions
          rowLabel={code.code}
          primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEdit(code) }}
          items={[
            { key: 'category', label: 'Change labor category…', icon: 'laborCategory', onSelect: () => setCategoryFor(code) },
            code.isActive
              ? { key: 'deactivate', label: 'Deactivate…', icon: 'deactivate', tone: 'danger', onSelect: () => setConfirmTarget(code) }
              : { key: 'reactivate', label: 'Reactivate…', icon: 'reactivate', busy: busyRows.isBusy(code.id), onSelect: () => openReactivate(code) },
          ]}
        />
      );
    },
    emptyState: { title: 'No charge codes match.' },
  });

  return (
    <>
      <PageHeader
        title="Charge codes"
        description="The codes people charge time to: direct codes bill a contract's CLIN; indirect codes cover overhead, G&A and leave."
        actions={tab === 'direct' ? (
          <Group gap="sm">
            <WriteButton variant="default" onClick={() => setBridgeOpen(true)}>Create codes from CLINs…</WriteButton>
            <WriteButton leftSection={<Icons.create size={ICON_SIZE.button} />} onClick={openCreate}>Add charge code</WriteButton>
          </Group>
        ) : (
          <WriteButton leftSection={<Icons.create size={ICON_SIZE.button} />} onClick={() => indirectRef.current?.openCreate()}>Add indirect code</WriteButton>
        )}
      />

      <Tabs value={tab} onChange={switchTab} mb="md">
        <Tabs.List>
          <Tabs.Tab value="direct">Direct ({formatCount(codes.filter((c) => c.isActive).length)})</Tabs.Tab>
          <Tabs.Tab value="indirect">Indirect ({formatCount(indirectCount)})</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="direct" pt="md" data-testid="direct-panel">
          {codes.length === 0 ? (
            <Stack align="center" gap={6} py="xl" data-testid="codes-empty">
              <Text fw={600}>No charge codes yet.</Text>
              <Text size="sm" c="dimmed">Create one per CLIN, or add one yourself.</Text>
              <WriteButton variant="default" mt="xs" onClick={() => setBridgeOpen(true)}>Create codes from CLINs…</WriteButton>
            </Stack>
          ) : (
            <Stack gap="sm">
              <Group gap="md" align="flex-end">
                <Select
                  label="Status" w={160} allowDeselect={false}
                  data={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }]}
                  value={status} onChange={(v) => setStatus((v as StatusFilter) ?? 'active')}
                />
              </Group>
              <MantineReactTable table={table} />
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="indirect" pt="md" data-testid="indirect-panel">
          <IndirectCodesPanel ref={indirectRef} initialCodes={indirectCodes} onCountChange={setIndirectCount} />
        </Tabs.Panel>
      </Tabs>

      <CreateFromClinsModal opened={bridgeOpen} onClose={() => setBridgeOpen(false)} onCreated={refreshCodes} />

      <Modal opened={modalOpen} onClose={() => { if (!busy.is('save')) setModalOpen(false); }} title={editingId ? 'Edit charge code' : 'Add charge code'} size="lg">
        <Stack gap="md">
          {serverError && <Alert color="red" role="alert" data-testid="code-form-error">{serverError}</Alert>}
          <TextInput label="Code" placeholder="G0490.ID.IaaS.OY7.SWE3" required error={errors.code}
            value={form.code} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, code: v })); }} />
          <TextInput label="Name" placeholder="Human-readable label" required error={errors.name}
            value={form.name} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, name: v })); }} />
          <Textarea label="Description" placeholder="Optional description"
            value={form.description} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, description: v })); }} />

          {lockReason && editingRow ? (
            // C5 + §3.4: the server won't move this code to another CLIN or SLIN — show where it is, read-only, and why.
            <TextInput
              label="Contract, CLIN and SLIN"
              readOnly
              value={`${editingRow.contractNumber} — ${editingRow.contractName} · CLIN ${editingRow.clinNumber}${editingRow.slinNumber ? ` · SLIN ${editingRow.slinNumber}` : ''}`}
              description={lockReason === 'hours'
                ? "This code has recorded hours, so its CLIN and SLIN can't change. Create a new charge code to use a different CLIN."
                : "Remove this code's labor categories before moving it to another CLIN or SLIN."}
              data-testid="charge-code-clin-locked"
            />
          ) : (
            <>
              <Select label="Contract" placeholder="Select contract" required
                data={contractOptions}
                description={editingRow && !editClinActive ? 'This CLIN or its contract is inactive. Choose another CLIN to move the code, or leave it to edit the other fields.' : undefined}
                value={form.contractId} onChange={(v) => setForm((f) => ({ ...f, contractId: v ?? '', clinId: '', slinId: '' }))} />

              {/* null, not '': Mantine keeps showing the previous option's label for a value it can't find. */}
              <Select label="CLIN" placeholder={form.contractId ? 'Select CLIN' : 'Choose a contract first'} required error={errors.clin}
                data={clinOptions} value={form.clinId || null}
                onChange={(v) => setForm((f) => ({ ...f, clinId: v ?? '', slinId: '' }))} />

              <Select label="SLIN" data={slinOptions} value={form.slinId} allowDeselect={false}
                onChange={(v) => setForm((f) => ({ ...f, slinId: v ?? '' }))} />
            </>
          )}

          <Select label="Location" placeholder="Not specified"
            data={WORK_LOCATION_OPTIONS} value={form.workLocation}
            onChange={(v) => setForm((f) => ({ ...f, workLocation: v ?? '' }))} />

          <Group align="flex-end">
            <Select label="Class (optional)" placeholder="Select class" clearable
              data={classList.map((c) => ({ value: c.id, label: c.name }))}
              value={form.classId || null} onChange={(v) => setForm((f) => ({ ...f, classId: v ?? '' }))}
              style={{ flex: 1 }} />
            <TextInput placeholder="New class name" aria-label="New class name" value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)} style={{ flex: 1 }} />
            <WriteButton variant="default" {...busy.props('class')} onClick={() => { void handleAddClass(); }}>Add</WriteButton>
          </Group>

          <Switch label="Billable" checked={form.billable}
            onChange={(e) => { const checked = e.target.checked; setForm((f) => ({ ...f, billable: checked })); }} />

          <Group justify="flex-end">
            <Button variant="default" onClick={() => { if (!busy.is('save')) setModalOpen(false); }}>Cancel</Button>
            <WriteButton {...busy.props('save')} onClick={() => { void handleSave(); }}>Save</WriteButton>
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
        loading={busy.is('deactivate')}
        onConfirm={() => { if (confirmTarget) void handleDeactivate(confirmTarget.id, confirmTarget.code); }}
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
        loading={busy.is('reactivate')}
        onConfirm={() => { if (reactivateTarget) void handleReactivate(reactivateTarget.row.id, reactivateTarget.row.code); }}
        onCancel={() => setReactivateTarget(null)}
      />
    </>
  );
}
