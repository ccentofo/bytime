'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Anchor, Button, Modal, TextInput, Select, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { RowActions } from '@/components/ui/RowActions';
import { useLastTarget } from '@/components/ui/useRowState';
import { useBusy } from '@/components/ui/useBusy';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Notice } from '@/components/ui/Notice';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAppTable, numericColumn, type AppTableExpandable } from '@/components/table/mrtDefaults';
import { runAction } from '@/lib/run-action';
import { toastError } from '@/lib/toast';
import { formatCount, formatCurrency, formatHours } from '@/lib/format';
import { UNPRICED_REPORT_HREF } from '@/lib/cost-labels';
import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { rateDisplay, type RateChange, type RateSchedule, type RateScheduleView } from '@/lib/labor-rates';
import { createLaborCategory, updateLaborCategory, getAllLaborCategories } from '@/server/actions/labor-categories';
import { getClinsByContract } from '@/server/actions/clins';
import { RateScheduleModal } from './RateScheduleModal';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';
import classes from './LaborCategories.module.css';

// ---------------------------------------------------------------------------
// Types (derived from server action return types)
// ---------------------------------------------------------------------------

type LaborCategory = {
  id: string;
  clinId: string;
  slinId: string | null;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
  clinNumber: string;
  clinDescription: string | null;
  contractId: string;
  contractName: string;
  contractNumber: string;
  slinNumber: string | null;
  /** Dated rates: hourlyRate / ceilingRate are the STARTING rate; these are the dated changes. */
  rateChanges: RateChange[];
};

type Contract = {
  id: string;
  contractNumber: string;
  name: string;
  status: 'active' | 'inactive' | 'closed';
};

type Clin = {
  id: string;
  clinNumber: string;
  description: string | null;
};

type LcatForm = {
  contractId: string | null;
  clinId: string | null;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate: string;
};

/** A table row: a contract group, or one category under it (feature-plan-ux-kit-contracts.md §4.2.5). */
type Row = {
  level: 'contract' | 'lcat';
  id: string;
  contract: { id: string; name: string; number: string; count: number };
  lc?: LaborCategory;
  children?: Row[];
};

type Props = {
  initialLaborCategories: LaborCategory[];
  contracts: Contract[];
  /** Employees holding each category on the workspace's today (absent = 0). */
  peopleCounts: Record<string, number>;
  /** All-time unpriced hours (the notice); 0 hides it. */
  unpricedHours: number;
  /** The workspace's today (server — never the browser clock), for the current-rate display. */
  today: CalendarDate;
};

const EMPTY_LCAT_FORM: LcatForm = {
  contractId: null,
  clinId: null,
  lcatCode: '',
  title: '',
  hourlyRate: '',
  ceilingRate: '',
};

/** validateRate's ceiling (lib/validation.ts) — MoneyInput checks it on blur; the server enforces it. */
const MAX_RATE = 9_999.99;

const rate = (v: string | null) => formatCurrency(v);

export function LaborCategoriesClient({ initialLaborCategories, contracts, peopleCounts, unpricedHours, today }: Props) {
  const canWrite = useCanWrite();
  const busy = useBusy();
  const [laborCats, setLaborCats] = useState<LaborCategory[]>(initialLaborCategories);

  // Dated rates D2: the Rates modal and the current-rate lookups (all from the same laborCats state).
  const [ratesFor, setRatesFor] = useState<LaborCategory | null>(null);
  const scheduleOf = (lc: LaborCategory): RateSchedule => ({ starting: { hourlyRate: lc.hourlyRate, ceilingRate: lc.ceilingRate }, changes: lc.rateChanges ?? [] });
  function mergeSchedule(view: RateScheduleView) {
    setLaborCats((prev) => prev.map((lc) => (lc.id === view.laborCategoryId
      ? { ...lc, hourlyRate: view.starting.hourlyRate, ceilingRate: view.starting.ceilingRate, rateChanges: view.changes }
      : lc)));
  }

  // LCAT Modal state
  const [lcatModalOpen, setLcatModalOpen] = useState(false);
  const [editingLcat, setEditingLcat] = useState<LaborCategory | null>(null);
  const [lcatForm, setLcatForm] = useState<LcatForm>(EMPTY_LCAT_FORM);
  const [clinOptions, setClinOptions] = useState<{ value: string; label: string }[]>([]);
  const [confirmDeactivateLcat, setConfirmDeactivateLcat] = useState<LaborCategory | null>(null);
  const shownDeactivate = useLastTarget(confirmDeactivateLcat);

  // --- LCAT Modal handlers ---

  function openAddLcatModal() {
    setEditingLcat(null);
    setLcatForm(EMPTY_LCAT_FORM);
    setClinOptions([]);
    setLcatModalOpen(true);
  }

  function openEditLcatModal(lcat: LaborCategory) {
    setEditingLcat(lcat);
    setLcatForm({
      contractId: null, // not needed for edit
      clinId: lcat.clinId,
      lcatCode: lcat.lcatCode,
      title: lcat.title,
      hourlyRate: lcat.hourlyRate,
      ceilingRate: lcat.ceilingRate ?? '',
    });
    setLcatModalOpen(true);
  }

  function handleContractChange(contractId: string | null) {
    setLcatForm((f) => ({ ...f, contractId, clinId: null }));
    setClinOptions([]);
    if (!contractId) return;
    void busy.run('clins', async () => {
      const fetchedClins = await getClinsByContract(contractId);
      setClinOptions(
        (fetchedClins as Clin[]).map((c) => ({
          value: c.id,
          label: `${c.clinNumber}${c.description ? ' — ' + c.description : ''}`,
        }))
      );
    });
  }

  async function refreshLaborCategories() {
    setLaborCats((await getAllLaborCategories()) as LaborCategory[]);
  }

  async function handleLcatSubmit() {
    // Dated rates D1.6: editing never sends rates (they change only through the Rates schedule); create sets the starting rate.
    if (!lcatForm.lcatCode.trim() || !lcatForm.title.trim() || (!editingLcat && !lcatForm.hourlyRate.trim())) return;
    try {
      if (editingLcat) {
        const result = await runAction(updateLaborCategory(editingLcat.id, {
          lcatCode: lcatForm.lcatCode.trim(),
          title: lcatForm.title.trim(),
        }), { errorTitle: 'Couldn’t update labor category' });
        if (!result.ok) return;
        notifications.show({ title: 'Labor Category Updated', message: `${lcatForm.lcatCode} has been updated.`, color: 'success' });
      } else {
        if (!lcatForm.clinId) return;
        const result = await runAction(createLaborCategory({
          clinId: lcatForm.clinId,
          lcatCode: lcatForm.lcatCode.trim(),
          title: lcatForm.title.trim(),
          hourlyRate: lcatForm.hourlyRate.trim(),
          ceilingRate: lcatForm.ceilingRate.trim() || undefined,
        }), { errorTitle: 'Couldn’t create labor category' });
        if (!result.ok) return;
        notifications.show({ title: 'Labor Category Created', message: `${lcatForm.lcatCode} has been created.`, color: 'success' });
      }
      await refreshLaborCategories();
      setLcatModalOpen(false);
    } catch {
      toastError({ title: 'Error', message: 'Something went wrong. Please refresh and try again.' });
    }
  }

  async function handleToggleStatus(lcat: LaborCategory) {
    const newStatus = lcat.status === 'active' ? 'inactive' : 'active';
    try {
      const result = await runAction(updateLaborCategory(lcat.id, { status: newStatus }), { errorTitle: 'Couldn’t update status' });
      if (!result.ok) return;
      await refreshLaborCategories();
      notifications.show({
        title: 'Status Updated',
        message: `${lcat.lcatCode} is now ${newStatus}.`,
        color: newStatus === 'active' ? 'success' : 'gray',
      });
      setConfirmDeactivateLcat(null);
    } catch {
      toastError({ title: 'Error', message: 'Something went wrong. Please refresh and try again.' });
    }
  }

  // --- Rows: grouped by contract (in the server's contract → CLIN → code order) ---

  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, Row>();
    for (const lc of laborCats) {
      let group = groups.get(lc.contractId);
      if (!group) {
        group = { level: 'contract', id: lc.contractId, contract: { id: lc.contractId, name: lc.contractName, number: lc.contractNumber, count: 0 }, children: [] };
        groups.set(lc.contractId, group);
      }
      group.contract.count += 1;
      group.children!.push({ level: 'lcat', id: lc.id, contract: group.contract, lc });
    }
    return [...groups.values()];
  }, [laborCats]);

  // --- Table ---

  const rateCell = (lc: LaborCategory, which: 'hourlyRate' | 'ceilingRate') => {
    // The rate in effect today, and the next later change (dimmed) if one exists.
    const { current, next } = rateDisplay(scheduleOf(lc), today);
    const testId = which === 'hourlyRate' ? 'lcat-current-hourly' : undefined;
    return (
      <>
        <span data-testid={testId}>{rate(current[which])}</span>
        {next && (
          <div className={classes.next} data-testid={which === 'hourlyRate' ? 'lcat-next-hourly' : undefined}>
            → {rate(next[which])} from {formatCalendarDate(next.effectiveDate, 'MMM D, YYYY')}
          </div>
        )}
      </>
    );
  };

  const columns: MRT_ColumnDef<Row>[] = [
    {
      id: 'category', header: 'Category', enableSorting: false,
      Cell: ({ row: { original: r } }) => {
        if (r.level === 'contract') {
          return (
            <span className={classes.oneLine}>
              <Text fw={600} span>{r.contract.name}</Text>{' '}
              <span className={`${classes.sub} ${classes.mono}`}>{r.contract.number}</span>{' '}
              <span className={classes.sub}>· {formatCount(r.contract.count)} {r.contract.count === 1 ? 'category' : 'categories'}</span>
            </span>
          );
        }
        const lc = r.lc!;
        return (
          <span className={classes.oneLine}>
            {lc.title} <span className={classes.sub}>· CLIN {lc.clinNumber}{lc.slinNumber ? ` · SLIN ${lc.slinNumber}` : ''}</span>
          </span>
        );
      },
    },
    {
      id: 'code', header: 'Code', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.lc ? <span className={classes.mono}>{r.lc.lcatCode}</span> : null),
    },
    numericColumn<Row>({ id: 'hourlyRate', header: 'Hourly rate', enableSorting: false, Cell: ({ row: { original: r } }) => (r.lc ? rateCell(r.lc, 'hourlyRate') : null) }),
    numericColumn<Row>({ id: 'ceilingRate', header: 'Ceiling rate', enableSorting: false, Cell: ({ row: { original: r } }) => (r.lc ? rateCell(r.lc, 'ceilingRate') : null) }),
    numericColumn<Row>({
      id: 'people', header: 'People', enableSorting: false,
      Cell: ({ row: { original: r } }) => {
        if (!r.lc) return null;
        const n = peopleCounts[r.lc.id] ?? 0;
        if (n === 0) return formatCount(0);
        return (
          <Anchor component={Link} href={`/admin/assignments?tab=labor-categories&laborCategoryId=${r.lc.id}`}
            aria-label={`${formatCount(n)} ${n === 1 ? 'person' : 'people'} in ${r.lc.lcatCode}`}>
            {formatCount(n)}
          </Anchor>
        );
      },
    }),
    {
      id: 'status', header: 'Status', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.lc ? <StatusBadge status={r.lc.status} /> : null),
    },
  ];

  const expandable = useMemo<AppTableExpandable<Row>>(() => ({
    getSubRows: (r) => r.children,
    label: (r) => (r.level === 'contract' ? `categories for ${r.contract.name}` : r.lc!.lcatCode),
    searchText: (r) => (r.level === 'contract' ? `${r.contract.name} ${r.contract.number}` : `${r.lc!.title} ${r.lc!.lcatCode}`),
    rowId: (r) => `${r.level}:${r.id}`,
    defaultExpanded: true, // groups start expanded (§4.2.5)
  }), []);

  const lcatTable = useAppTable<Row>({
    columns,
    data: rows,
    expandable,
    hairline: true,
    compact: rows.length <= 25,
    enableRowActions: true,
    renderRowActions: ({ row: { original: r } }) => {
      if (!r.lc) return null;
      const lcat = r.lc;
      return (
        <RowActions
          rowLabel={lcat.lcatCode}
          primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEditLcatModal(lcat) }}
          items={[
            { key: 'rates', label: 'Rates', icon: 'rates', onSelect: () => setRatesFor(lcat) },
            lcat.status === 'active'
              ? { key: 'deactivate', label: 'Deactivate…', icon: 'deactivate', tone: 'danger', onSelect: () => setConfirmDeactivateLcat(lcat) }
              : { key: 'reactivate', label: 'Reactivate', icon: 'reactivate', busy: busy.is(`row:${lcat.id}`), onSelect: () => { void busy.run(`row:${lcat.id}`, () => handleToggleStatus(lcat)); } },
          ]}
        />
      );
    },
    emptyState: { title: 'No labor categories yet', body: 'Add a labor category to set a billing rate on a CLIN.' },
  });

  return (
    <>
      <PageHeader
        title="Labor categories"
        description="Each category's billing rate on a CLIN. Charge codes and employees use these to price hours."
        actions={
          <WriteButton leftSection={<Icons.create size={ICON_SIZE.button} />} onClick={openAddLcatModal}>
            Add labor category
          </WriteButton>
        }
        notices={unpricedHours > 0 && (
          <Notice action={{ label: 'See what to fix', href: UNPRICED_REPORT_HREF }}>
            <b>{formatHours(unpricedHours)} hours have no labor-category rate,</b> so their cost isn&apos;t counted.
          </Notice>
        )}
      />
      <MantineReactTable table={lcatTable} />

      {/* ---- Add/Edit LCAT Modal ---- */}
      <Modal
        opened={lcatModalOpen}
        onClose={() => { if (!busy.is('save')) setLcatModalOpen(false); }}
        title={editingLcat ? 'Edit Labor Category' : 'Add Labor Category'}
        size="md"
      >
        <Stack>
          {!editingLcat && (
            <>
              <Select
                label="Contract"
                placeholder="Select contract"
                data={contracts.map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.contractNumber})`,
                }))}
                value={lcatForm.contractId}
                onChange={handleContractChange}
                searchable
              />
              <Select
                label="CLIN"
                placeholder={lcatForm.contractId ? 'Select CLIN' : 'Select a contract first'}
                data={clinOptions}
                value={lcatForm.clinId}
                onChange={(val) => setLcatForm((f) => ({ ...f, clinId: val }))}
                disabled={!lcatForm.contractId || clinOptions.length === 0}
                searchable
              />
            </>
          )}
          {editingLcat && (
            <Text size="sm" c="dimmed">
              Editing LCAT for CLIN {editingLcat.clinNumber} on {editingLcat.contractName}
            </Text>
          )}
          <TextInput
            label="LCAT Code"
            required
            placeholder="SE-III"
            value={lcatForm.lcatCode}
            onChange={(e) => setLcatForm((f) => ({ ...f, lcatCode: e.target.value }))}
          />
          <TextInput
            label="Title"
            required
            placeholder="Senior Engineer III"
            value={lcatForm.title}
            onChange={(e) => setLcatForm((f) => ({ ...f, title: e.target.value }))}
          />
          {!editingLcat && (
            <>
              <MoneyInput
                label="Starting hourly rate"
                required
                placeholder="$125.00"
                max={MAX_RATE}
                value={lcatForm.hourlyRate}
                onChange={(v) => setLcatForm((f) => ({ ...f, hourlyRate: v }))}
              />
              <MoneyInput
                label="Starting ceiling rate"
                placeholder="$150.00 (optional)"
                max={MAX_RATE}
                value={lcatForm.ceilingRate}
                onChange={(v) => setLcatForm((f) => ({ ...f, ceilingRate: v }))}
              />
            </>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setLcatModalOpen(false)}>
              Cancel
            </Button>
            <WriteButton
              {...busy.props('save')}
              onClick={() => { void busy.run('save', handleLcatSubmit); }}
              disabled={
                !lcatForm.lcatCode.trim() ||
                !lcatForm.title.trim() ||
                (!editingLcat && !lcatForm.hourlyRate.trim()) ||
                (!editingLcat && !lcatForm.clinId)
              }
            >
              {editingLcat ? 'Save Changes' : 'Create'}
            </WriteButton>
          </Group>
        </Stack>
      </Modal>

      <RateScheduleModal
        opened={!!ratesFor}
        onClose={() => setRatesFor(null)}
        category={ratesFor ? { id: ratesFor.id, lcatCode: ratesFor.lcatCode, title: ratesFor.title, schedule: scheduleOf(ratesFor) } : null}
        canWrite={canWrite}
        onSaved={mergeSchedule}
      />

      <ConfirmModal
        opened={!!confirmDeactivateLcat}
        title="Deactivate labor category?"
        message={shownDeactivate ? `This deactivates ${shownDeactivate.lcatCode} — ${shownDeactivate.title}.` : ''}
        confirmLabel="Deactivate"
        loading={busy.is('status')}
        onConfirm={() => { if (confirmDeactivateLcat) void busy.run('status', () => handleToggleStatus(confirmDeactivateLcat)); }}
        onCancel={() => setConfirmDeactivateLcat(null)}
      />
    </>
  );
}
