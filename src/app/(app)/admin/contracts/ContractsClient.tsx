'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Alert, Anchor, Button, Group, Modal, Paper, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { RowActions, type RowAction } from '@/components/ui/RowActions';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Notice } from '@/components/ui/Notice';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { PageHeader } from '@/components/ui/PageHeader';
import { useBusy } from '@/components/ui/useBusy';
import { useLastTarget } from '@/components/ui/useRowState';
import { useAppTable, numericColumn, type AppTableExpandable } from '@/components/table/mrtDefaults';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { createContract, updateContract } from '@/server/actions/contracts';
import { createClin, updateClin } from '@/server/actions/clins';
import { createSlin, updateSlin } from '@/server/actions/slins';
import type { ClinNode, ContractNode, ContractsOverview, Money, RecordStatus, SlinNode } from '@/server/internal/contracts-overview';
import { runAction } from '@/lib/run-action';
import { formatCurrency, formatDate, formatHours } from '@/lib/format';
import { CURRENT_RATES_NOTE, unpricedReportHref } from '@/lib/cost-labels';
import { BURN_TIER_LABEL, burnPercent, burnTier } from '@/lib/ui/burn';
import { isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import classes from './Contracts.module.css';

/**
 * Contracts and CLINs (feature-plan-ux-kit-contracts.md §4.1; mockup "Contracts"): one page for the money and the
 * structure. A summary strip (active contracts), one unpriced notice, and an expandable contract → CLIN → SLIN table
 * with funded / spent / remaining / burn and each row's unpriced hours. Writes merge the row the server returns, then
 * router.refresh() brings the recomputed money.
 */

type Level = 'contract' | 'clin' | 'slin';
interface Row {
  level: Level;
  id: string;
  contract: ContractNode;
  clin?: ClinNode;
  slin?: SlinNode;
  node: Money & { status: RecordStatus };
  children?: Row[];
}

type ContractForm = {
  contractNumber: string; name: string; description: string; contractType: 'prime' | 'sub';
  startDate: CalendarDate | null; endDate: CalendarDate | null; funded: string; ceiling: string;
};
type LineForm = { number: string; description: string; funded: string };
type Dialog =
  | { kind: 'contract'; contract?: ContractNode }
  | { kind: 'clin'; contract: ContractNode; clin?: ClinNode }
  | { kind: 'slin'; contract: ContractNode; clin: ClinNode; slin?: SlinNode };

const END_BEFORE_START = 'The end date must be on or after the start date.';
const DEACTIVATE_LINE_MESSAGE = "Employees can't charge new time to it. Existing hours stay on record.";
const num = (v: string | null | undefined) => {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── Merge a saved row from the server into the tree (never the form values: an omitted field stays as stored). ──────
type ContractRowIn = { id: string; contractNumber: string; name: string; description: string | null; contractType: string; status: string; startDate: string | null; endDate: string | null; fundedValue: string | null; ceilingValue: string | null };
type LineRowIn = { id: string; description: string | null; fundedAmount: string | null; status: string };
const fromContractRow = (r: ContractRowIn, prev?: ContractNode): ContractNode => ({
  ...(prev ?? { hours: 0, pricedCost: 0, unpricedHours: 0, clins: [] }),
  id: r.id, contractNumber: r.contractNumber, name: r.name, description: r.description,
  contractType: r.contractType === 'sub' ? 'sub' : 'prime', status: r.status as RecordStatus,
  startDate: (r.startDate as CalendarDate | null) ?? null, endDate: (r.endDate as CalendarDate | null) ?? null,
  funded: r.fundedValue, ceiling: r.ceilingValue,
});

export function ContractsClient({ overview }: { overview: ContractsOverview }) {
  const router = useRouter();
  const busy = useBusy();

  // Local tree: the server's, with saved rows merged in until router.refresh() brings a fresh `overview`.
  const [source, setSource] = useState(overview);
  const [contracts, setContracts] = useState<ContractNode[]>(overview.contracts);
  if (source !== overview) {
    setSource(overview);
    setContracts(overview.contracts);
  }

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [contractForm, setContractForm] = useState<ContractForm | null>(null);
  const [lineForm, setLineForm] = useState<LineForm>({ number: '', description: '', funded: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [statusConfirm, setStatusConfirm] = useState<{ contract: ContractNode; to: 'closed' | 'active' } | null>(null);
  const [lineConfirm, setLineConfirm] = useState<{ level: 'clin' | 'slin'; contract: ContractNode; clin: ClinNode; slin?: SlinNode } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // The confirms keep showing the last target while they animate closed (no "Close ?" flash).
  const shownStatus = useLastTarget(statusConfirm);
  const shownLine = useLastTarget(lineConfirm);

  // ── Strip totals (C2): money and counts over ACTIVE contracts; unpriced over ALL (Home's figure). ─────────────────
  const totals = useMemo(() => {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const active = contracts.filter((c) => c.status === 'active');
    const funded = round2(active.reduce((s, c) => s + (num(c.funded) ?? 0), 0));
    const spent = round2(active.reduce((s, c) => s + c.pricedCost, 0));
    return { active: active.length, funded, spent, remaining: round2(funded - spent), unpricedAll: round2(contracts.reduce((s, c) => s + c.unpricedHours, 0)) };
  }, [contracts]);

  const rows = useMemo<Row[]>(() => contracts.map((contract) => ({
    level: 'contract', id: contract.id, contract, node: contract,
    children: contract.clins.map((clin) => ({
      level: 'clin', id: clin.id, contract, clin, node: clin,
      children: clin.slins.map((slin) => ({ level: 'slin', id: slin.id, contract, clin, slin, node: slin })),
    })),
  })), [contracts]);

  // ── Writes ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const patchContract = (id: string, fn: (c: ContractNode) => ContractNode) =>
    setContracts((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  const patchClin = (contractId: string, clinId: string, fn: (c: ClinNode) => ClinNode) =>
    patchContract(contractId, (c) => ({ ...c, clins: c.clins.map((cl) => (cl.id === clinId ? fn(cl) : cl)) }));

  function openContractDialog(contract?: ContractNode) {
    setDialog({ kind: 'contract', contract });
    setContractForm({
      contractNumber: contract?.contractNumber ?? '', name: contract?.name ?? '', description: contract?.description ?? '',
      contractType: contract?.contractType ?? 'prime', startDate: contract?.startDate ?? null, endDate: contract?.endDate ?? null,
      funded: contract?.funded ?? '', ceiling: contract?.ceiling ?? '',
    });
    setFormError(null);
    setDateError(null);
  }

  function openLineDialog(d: Exclude<Dialog, { kind: 'contract' }>) {
    const existing = d.kind === 'clin' ? d.clin : d.slin;
    setDialog(d);
    setLineForm({
      number: existing ? (d.kind === 'clin' ? (existing as ClinNode).clinNumber : (existing as SlinNode).slinNumber) : '',
      description: existing?.description ?? '',
      funded: existing?.funded ?? '',
    });
    setFormError(null);
  }

  function closeDialog() {
    if (busy.is('save')) return;
    setDialog(null);
  }

  async function saveContract() {
    if (!contractForm || dialog?.kind !== 'contract') return;
    setFormError(null);
    if (contractForm.startDate && contractForm.endDate && contractForm.endDate < contractForm.startDate) {
      setDateError(END_BEFORE_START);
      return;
    }
    setDateError(null);
    const payload = {
      contractNumber: contractForm.contractNumber, name: contractForm.name, description: contractForm.description,
      contractType: contractForm.contractType,
      startDate: contractForm.startDate ?? undefined, endDate: contractForm.endDate ?? undefined,
      fundedValue: contractForm.funded, ceilingValue: contractForm.ceiling,
    };
    const editing = dialog.contract;
    const result = editing
      ? await runAction(updateContract(editing.id, payload), { silent: true })
      : await runAction(createContract(payload), { silent: true });
    if (!result.ok) { setFormError(result.error); return; }
    const saved = result.data as ContractRowIn;
    if (editing) patchContract(editing.id, (c) => fromContractRow(saved, c));
    else setContracts((prev) => [...prev, fromContractRow(saved)].sort((a, b) => a.name.localeCompare(b.name)));
    setDialog(null);
    router.refresh();
  }

  async function saveLine() {
    if (!dialog || dialog.kind === 'contract') return;
    setFormError(null);
    const base = { description: lineForm.description, fundedAmount: lineForm.funded };
    if (dialog.kind === 'clin') {
      const result = dialog.clin
        ? await runAction(updateClin(dialog.clin.id, { clinNumber: lineForm.number, ...base }), { silent: true })
        : await runAction(createClin({ contractId: dialog.contract.id, clinNumber: lineForm.number, ...base }), { silent: true });
      if (!result.ok) { setFormError(result.error); return; }
      const r = result.data as LineRowIn & { clinNumber: string };
      const merged = (prev?: ClinNode): ClinNode => ({
        ...(prev ?? { hours: 0, pricedCost: 0, unpricedHours: 0, slins: [] }),
        id: r.id, clinNumber: r.clinNumber, description: r.description, funded: r.fundedAmount, status: r.status as RecordStatus,
      });
      if (dialog.clin) patchClin(dialog.contract.id, dialog.clin.id, merged);
      else patchContract(dialog.contract.id, (c) => ({ ...c, clins: [...c.clins, merged()].sort((a, b) => a.clinNumber.localeCompare(b.clinNumber)) }));
    } else {
      const result = dialog.slin
        ? await runAction(updateSlin(dialog.slin.id, { slinNumber: lineForm.number, ...base }), { silent: true })
        : await runAction(createSlin({ clinId: dialog.clin.id, slinNumber: lineForm.number, ...base }), { silent: true });
      if (!result.ok) { setFormError(result.error); return; }
      const r = result.data as LineRowIn & { slinNumber: string };
      const merged = (prev?: SlinNode): SlinNode => ({
        ...(prev ?? { hours: 0, pricedCost: 0, unpricedHours: 0 }),
        id: r.id, slinNumber: r.slinNumber, description: r.description, funded: r.fundedAmount, status: r.status as RecordStatus,
      });
      const slinId = dialog.slin?.id;
      patchClin(dialog.contract.id, dialog.clin.id, (cl) => ({
        ...cl,
        slins: slinId ? cl.slins.map((s) => (s.id === slinId ? merged(s) : s)) : [...cl.slins, merged()].sort((a, b) => a.slinNumber.localeCompare(b.slinNumber)),
      }));
    }
    setDialog(null);
    router.refresh();
  }

  async function setContractStatus() {
    if (!statusConfirm) return;
    setConfirmError(null);
    const result = await runAction(updateContract(statusConfirm.contract.id, { status: statusConfirm.to }), { silent: true });
    if (!result.ok) { setConfirmError(result.error); return; }
    patchContract(statusConfirm.contract.id, (c) => fromContractRow(result.data as ContractRowIn, c));
    setStatusConfirm(null);
    router.refresh();
  }

  async function setLineStatus(target: { level: 'clin' | 'slin'; contract: ContractNode; clin: ClinNode; slin?: SlinNode }, to: RecordStatus, fromConfirm: boolean) {
    if (fromConfirm) setConfirmError(null);
    const result = target.level === 'clin'
      ? await runAction(updateClin(target.clin.id, { status: to }), { silent: fromConfirm, errorTitle: 'Couldn’t update CLIN' })
      : await runAction(updateSlin(target.slin!.id, { status: to }), { silent: fromConfirm, errorTitle: 'Couldn’t update SLIN' });
    if (!result.ok) { if (fromConfirm) setConfirmError(result.error); return; }
    const status = (result.data as LineRowIn).status as RecordStatus;
    if (target.level === 'clin') patchClin(target.contract.id, target.clin.id, (cl) => ({ ...cl, status }));
    else patchClin(target.contract.id, target.clin.id, (cl) => ({ ...cl, slins: cl.slins.map((s) => (s.id === target.slin!.id ? { ...s, status } : s)) }));
    if (fromConfirm) setLineConfirm(null);
    router.refresh();
  }

  // ── Table ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const whole = (v: number | string | null) => formatCurrency(v, { cents: false });
  const remainingOf = (r: Row) => { const f = num(r.node.funded); return f === null ? null : f - r.node.pricedCost; };

  const columns = useMemo<MRT_ColumnDef<Row>[]>(() => [
    {
      id: 'name', header: 'Contract', enableSorting: false,
      Cell: ({ row: { original: r } }) => {
        if (r.level === 'contract') {
          const c = r.contract;
          return (
            <div className={classes.oneLine}>
              <Text fw={600} span>{c.name}</Text>
              <div className={classes.sub}>
                <span className={classes.pill}>{c.contractType === 'sub' ? 'Sub' : 'Prime'}</span>{' '}
                <span className={classes.mono}>{c.contractNumber}</span>
                {c.endDate && <> · ends {formatDate(c.endDate)}</>}
              </div>
            </div>
          );
        }
        const n = r.level === 'clin' ? `CLIN ${r.clin!.clinNumber}` : `SLIN ${r.slin!.slinNumber}`;
        const d = r.node === r.clin ? r.clin!.description : r.slin?.description;
        return <span className={classes.oneLine}>{n}{d ? ` · ${d}` : ''}</span>;
      },
    },
    numericColumn<Row>({ id: 'funded', header: 'Funded', enableSorting: false, accessorFn: (r) => r.node.funded, Cell: ({ row }) => whole(row.original.node.funded) }),
    numericColumn<Row>({ id: 'spent', header: 'Spent', enableSorting: false, accessorFn: (r) => r.node.pricedCost, Cell: ({ row }) => whole(row.original.node.pricedCost) }),
    numericColumn<Row>({ id: 'remaining', header: 'Remaining', enableSorting: false, accessorFn: (r) => remainingOf(r), Cell: ({ row }) => whole(remainingOf(row.original)) }),
    {
      id: 'burn', header: 'Burn', enableSorting: false,
      Cell: ({ row: { original: r } }) => {
        const funded = num(r.node.funded);
        if (funded === null || !(funded > 0)) return <span className={classes.sub}>{r.level === 'contract' ? BURN_TIER_LABEL.noFunding : '—'}</span>;
        const pct = burnPercent(r.node.pricedCost, funded);
        const tier = burnTier(pct, funded, funded - r.node.pricedCost);
        return (
          <div className={classes.burn} data-testid="burn">
            <div className={classes.bar} aria-hidden="true"><span style={{ width: `${Math.min(pct, 100)}%` }} /></div>
            <span className={classes.sub}>{r.level === 'contract' ? `${pct}% · ${BURN_TIER_LABEL[tier].toLowerCase()}` : `${pct}%`}</span>
          </div>
        );
      },
    },
    numericColumn<Row>({
      id: 'unpriced', header: 'Unpriced', enableSorting: false, accessorFn: (r) => r.node.unpricedHours,
      Cell: ({ row: { original: r } }) => (r.node.unpricedHours > 0 ? (
        <Anchor component={Link} size="sm" data-testid="unpriced-link"
          href={unpricedReportHref({ contractId: r.contract.id, clinId: r.clin?.id, slinId: r.slin?.id })}>
          {formatHours(r.node.unpricedHours)}
        </Anchor>
      ) : formatHours(0)),
    }),
    { id: 'status', header: 'Status', enableSorting: false, Cell: ({ row }) => <StatusBadge status={row.original.node.status} /> },
  ], []);

  const expandable = useMemo<AppTableExpandable<Row>>(() => ({
    getSubRows: (r) => r.children,
    // UX-4B1-AUDIT L4: CLIN numbers repeat across contracts, so a CLIN toggle names its contract.
    label: (r) => (r.level === 'contract' ? `CLINs for ${r.contract.name}` : r.level === 'clin' ? `SLINs for CLIN ${r.clin!.clinNumber} on ${r.contract.name}` : `SLIN ${r.slin!.slinNumber}`),
    // L6: the "CLIN" / "SLIN" prefix the cell shows is searchable too ("CLIN 0002").
    searchText: (r) => (r.level === 'contract' ? [r.contract.name, r.contract.contractNumber, r.contract.description]
      : r.level === 'clin' ? [`CLIN ${r.clin!.clinNumber}`, r.clin!.description] : [`SLIN ${r.slin!.slinNumber}`, r.slin!.description]).filter(Boolean).join(' '),
    rowId: (r) => `${r.level}:${r.id}`,
    defaultExpanded: overview.contracts.length === 1 ? { [`contract:${overview.contracts[0].id}`]: true } : {},
  }), [overview.contracts]);

  function rowActions(r: Row) {
    if (r.level === 'contract') {
      const c = r.contract;
      const items: RowAction[] = [
        { key: 'add-clin', label: 'Add CLIN', icon: 'create', hidden: c.status !== 'active', onSelect: () => openLineDialog({ kind: 'clin', contract: c }) },
        c.status === 'active'
          ? { key: 'close', label: 'Close contract…', icon: 'deactivate', tone: 'danger', onSelect: () => { setConfirmError(null); setStatusConfirm({ contract: c, to: 'closed' }); } }
          : { key: 'reopen', label: 'Reopen contract…', icon: 'reactivate', onSelect: () => { setConfirmError(null); setStatusConfirm({ contract: c, to: 'active' }); } },
      ];
      return <RowActions rowLabel={c.name} primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openContractDialog(c) }} items={items} />;
    }
    const target = { level: r.level as 'clin' | 'slin', contract: r.contract, clin: r.clin!, slin: r.slin };
    const name = r.level === 'clin' ? `CLIN ${r.clin!.clinNumber}` : `SLIN ${r.slin!.slinNumber}`;
    const active = r.node.status === 'active';
    const items: RowAction[] = [
      ...(r.level === 'clin' ? [{
        key: 'add-slin', label: 'Add SLIN', icon: 'create' as const, hidden: !(r.clin!.status === 'active' && r.contract.status === 'active'),
        onSelect: () => openLineDialog({ kind: 'slin', contract: r.contract, clin: r.clin! }),
      }] : []),
      active
        ? { key: 'deactivate', label: 'Deactivate…', icon: 'deactivate', tone: 'danger', onSelect: () => { setConfirmError(null); setLineConfirm(target); } }
        : { key: 'reactivate', label: 'Reactivate', icon: 'reactivate', busy: busy.is(`row:${r.id}`), onSelect: () => { void busy.run(`row:${r.id}`, () => setLineStatus(target, 'active', false)); } },
    ];
    const edit = r.level === 'clin'
      ? () => openLineDialog({ kind: 'clin', contract: r.contract, clin: r.clin! })
      : () => openLineDialog({ kind: 'slin', contract: r.contract, clin: r.clin!, slin: r.slin! });
    return <RowActions rowLabel={`${name} of ${r.contract.name}`} primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: edit }} items={items} />;
  }

  const table = useAppTable<Row>({
    columns,
    data: rows,
    expandable,
    hairline: true,
    compact: rows.length <= 25,
    enableRowActions: true,
    renderRowActions: ({ row }) => rowActions(row.original),
    emptyState: { title: 'No contracts yet', body: 'Add a contract to start tracking its CLINs, funding and spending.' },
  });

  // ── Render ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const burn = burnPercent(totals.spent, totals.funded);
  const parentLabel = dialog && dialog.kind !== 'contract'
    ? (dialog.kind === 'clin' ? `${dialog.contract.name} (${dialog.contract.contractNumber})` : `${dialog.contract.name} · CLIN ${dialog.clin.clinNumber}`)
    : '';
  const dialogTitle = !dialog ? '' : dialog.kind === 'contract' ? (dialog.contract ? 'Edit contract' : 'Add contract')
    : dialog.kind === 'clin' ? (dialog.clin ? `Edit CLIN ${dialog.clin.clinNumber}` : 'Add CLIN')
      : (dialog.slin ? `Edit SLIN ${dialog.slin.slinNumber}` : 'Add SLIN');

  return (
    <>
      <PageHeader
        title="Contracts and CLINs"
        description={<>Funding, spending and burn for each contract, CLIN and SLIN.<div style={{ fontSize: 'var(--mantine-font-size-xs)', marginTop: 2 }}>{CURRENT_RATES_NOTE}</div></>}
        actions={<WriteButton leftSection={<Icons.create size={ICON_SIZE.button} />} onClick={() => openContractDialog()}>Add contract</WriteButton>}
      />

      <Paper withBorder radius="md" className={classes.strip} data-testid="contracts-strip">
        <div><div className={classes.stripValue}>{totals.active}</div><div className={classes.stripLabel}>Active contracts</div></div>
        <div><div className={classes.stripValue}>{whole(totals.funded)}</div><div className={classes.stripLabel}>Funded</div></div>
        <div><div className={classes.stripValue}>{whole(totals.spent)}</div><div className={classes.stripLabel}>Spent (priced hours) · {burn}%</div></div>
        <div><div className={classes.stripValue}>{whole(totals.remaining)}</div><div className={classes.stripLabel}>Remaining</div></div>
      </Paper>

      {totals.unpricedAll > 0 && (
        <Notice action={{ label: 'Fix pricing', href: unpricedReportHref() }}>
          <b>{formatHours(totals.unpricedAll)} hours have no labor-category rate,</b> so their cost isn&apos;t counted above.
        </Notice>
      )}

      <MantineReactTable table={table} />

      <Modal opened={!!dialog} onClose={closeDialog} title={dialogTitle} size="md">
        {dialog?.kind === 'contract' && contractForm && (
          <Stack>
            <TextInput label="Contract number" required value={contractForm.contractNumber} onChange={(e) => setContractForm({ ...contractForm, contractNumber: e.currentTarget.value })} />
            <TextInput label="Name" required value={contractForm.name} onChange={(e) => setContractForm({ ...contractForm, name: e.currentTarget.value })} />
            <Textarea label="Description" value={contractForm.description} onChange={(e) => setContractForm({ ...contractForm, description: e.currentTarget.value })} />
            <Select
              label="Type" allowDeselect={false}
              data={[{ value: 'prime', label: 'Prime contract' }, { value: 'sub', label: 'Subcontract' }]}
              value={contractForm.contractType}
              onChange={(v) => setContractForm({ ...contractForm, contractType: v === 'sub' ? 'sub' : 'prime' })}
            />
            <Group grow align="flex-start">
              <DateInput label="Start date" clearable value={contractForm.startDate}
                onChange={(d) => { setDateError(null); setContractForm({ ...contractForm, startDate: d && isCalendarDate(d) ? d : null }); }} />
              <DateInput label="End date" clearable value={contractForm.endDate} error={dateError ?? undefined}
                onChange={(d) => { setDateError(null); setContractForm({ ...contractForm, endDate: d && isCalendarDate(d) ? d : null }); }} />
            </Group>
            <MoneyInput label="Funded" max={999_999_999.99} value={contractForm.funded} onChange={(v) => setContractForm({ ...contractForm, funded: v })} />
            <MoneyInput label="Ceiling" max={999_999_999.99} value={contractForm.ceiling} onChange={(v) => setContractForm({ ...contractForm, ceiling: v })} />
            {formError && <Alert color="red" role="alert">{formError}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={closeDialog}>Cancel</Button>
              <WriteButton {...busy.props('save')} onClick={() => { void busy.run('save', saveContract); }}>
                {dialog.contract ? 'Save changes' : 'Add contract'}
              </WriteButton>
            </Group>
          </Stack>
        )}
        {dialog && dialog.kind !== 'contract' && (
          <Stack>
            <TextInput label={dialog.kind === 'clin' ? 'Contract' : 'CLIN'} value={parentLabel} readOnly data-testid="line-parent" />
            <TextInput label={dialog.kind === 'clin' ? 'CLIN number' : 'SLIN number'} required value={lineForm.number} onChange={(e) => setLineForm({ ...lineForm, number: e.currentTarget.value })} />
            <TextInput label="Description" value={lineForm.description} onChange={(e) => setLineForm({ ...lineForm, description: e.currentTarget.value })} />
            <MoneyInput label="Funded" max={999_999_999.99} value={lineForm.funded} onChange={(v) => setLineForm({ ...lineForm, funded: v })} />
            {formError && <Alert color="red" role="alert">{formError}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={closeDialog}>Cancel</Button>
              <WriteButton {...busy.props('save')} onClick={() => { void busy.run('save', saveLine); }}>
                {(dialog.kind === 'clin' ? dialog.clin : dialog.slin) ? 'Save changes' : `Add ${dialog.kind === 'clin' ? 'CLIN' : 'SLIN'}`}
              </WriteButton>
            </Group>
          </Stack>
        )}
      </Modal>

      <ConfirmModal
        opened={!!statusConfirm}
        tone={shownStatus?.to === 'active' ? 'neutral' : 'danger'}
        title={shownStatus ? `${shownStatus.to === 'closed' ? 'Close' : 'Reopen'} ${shownStatus.contract.name}?` : ''}
        message={shownStatus?.to === 'active'
          ? 'Its active charge codes will appear on timesheets again for employees assigned to them.'
          : "Its charge codes will no longer appear on anyone's timesheet, and no one can add new hours to it. Recorded hours stay, and you can reopen it later."}
        confirmLabel={shownStatus?.to === 'active' ? 'Reopen contract' : 'Close contract'}
        loading={busy.is('status')}
        error={confirmError}
        onConfirm={() => { void busy.run('status', setContractStatus); }}
        onCancel={() => setStatusConfirm(null)}
      />

      <ConfirmModal
        opened={!!lineConfirm}
        title={shownLine ? (shownLine.level === 'clin' ? `Deactivate CLIN ${shownLine.clin.clinNumber}?` : `Deactivate SLIN ${shownLine.slin?.slinNumber}?`) : ''}
        message={DEACTIVATE_LINE_MESSAGE}
        confirmLabel="Deactivate"
        loading={busy.is('line')}
        error={confirmError}
        onConfirm={() => { if (lineConfirm) void busy.run('line', () => setLineStatus(lineConfirm, 'inactive', true)); }}
        onCancel={() => setLineConfirm(null)}
      />
    </>
  );
}
