'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ActionIcon, Badge, Button, Checkbox, Drawer, Group, Paper, Select, SimpleGrid, Stack, Tabs, Text, Timeline, Tooltip,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { MantineReactTable, type MRT_ColumnDef, type MRT_PaginationState, type MRT_Updater } from 'mantine-react-table';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { useAppTable, numericColumn } from '@/components/table/mrtDefaults';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PageHeader } from '@/components/ui/PageHeader';
import { useBusy } from '@/components/ui/useBusy';
import { toastError } from '@/lib/toast';
import { formatCount, formatHours } from '@/lib/format';
import { downloadFile } from '@/lib/download';
import { formatCalendarDate, formatInstant, isBefore, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { periodLabel } from '@/lib/timesheet/labels';
import { REASON_CODES, reasonLabel } from '@/lib/reason-codes';
import { auditCsvHref, auditSearch, last30Days, type AuditParams, type AuditRange, type AuditTab } from '@/lib/audit/audit-params';
import {
  getAdminChanges, getAuditEntries, getAuditPeriodEvents, getAuditSummary, getCellRevisionHistory, getClinsForFilter,
  type AdminChangeEntry, type AuditEntry, type AuditPeriodEvent, type CellRevisionHistory,
} from '@/server/actions/audit';
import { resolvePeriodRange } from '@/server/actions/periods';
import { isLateEntry } from '@/lib/audit/late-entry';

type ContractOption = { id: string; name: string; contractNumber: string };
type UserOption = { id: string; fullName: string; email: string };
type ClinOption = { id: string; clinNumber: string; description: string | null };

export type ResolvedAuditRange = { start: CalendarDate; end: CalendarDate; label: string };
export type AuditData = {
  entries?: { entries: AuditEntry[]; total: number; page: number; pageSize: number };
  summary?: { entries: number; changed: number; late: number; people: number };
  events?: { events: AuditPeriodEvent[]; truncated: boolean };
  admin?: { rows: AdminChangeEntry[]; total: number; page: number; pageSize: number };
};

type Props = {
  initialParams: AuditParams;
  initialRange: ResolvedAuditRange | null;
  initialData: AuditData;
  contracts: ContractOption[];
  users: UserOption[];
  initialClins?: ClinOption[];
  workspaceTimezone: string;
  workspaceToday: CalendarDate;
  isAdmin: boolean;
};

const PAGE_SIZE = 50;
export const END_BEFORE_START = 'End date must be on or after the start date.';
const REASON_OPTIONS = [
  { value: '', label: 'All reasons' },
  ...REASON_CODES.map((r) => ({ value: r.value, label: r.label })),
  { value: 'MIGRATION', label: reasonLabel('MIGRATION') },
];
const SELF_NOTE: Partial<Record<AuditPeriodEvent['event'], string>> = { approved: ' · self-approved', rejected: ' · self-returned' };


/**
 * Audit trail (feature-plan-ux-people-codes.md §6): the URL's filters, tab and page arrive loaded (no Search button).
 * Every change resolves the range to dates in the WORKSPACE's calendar (last 30 days, the last / this pay period, or
 * valid custom dates), writes the URL with history.replaceState (a filter change resets the page to 1) and loads the
 * tab; a request token applies only the latest response, and the table is aria-busy meanwhile.
 */
export function AuditTrailClient({
  initialParams, initialRange, initialData, contracts, users, initialClins = [], workspaceTimezone, workspaceToday, isAdmin,
}: Props) {
  const busy = useBusy();
  const [params, setParams] = useState<AuditParams>(initialParams);
  const [range, setRange] = useState<ResolvedAuditRange | null>(initialRange);
  const [data, setData] = useState<AuditData>(initialData);
  const [loading, setLoading] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [clins, setClins] = useState<ClinOption[]>(initialClins);
  const token = useRef(0);

  // Custom dates are edited locally; the query runs once both are valid and in order.
  const [customStart, setCustomStart] = useState<string | null>(initialParams.start);
  const [customEnd, setCustomEnd] = useState<string | null>(initialParams.end);

  async function resolveRange(p: AuditParams, start = customStart, end = customEnd): Promise<ResolvedAuditRange | null> {
    if (p.range === 'last30') { const r = last30Days(workspaceToday); return { ...r, label: `Last 30 days · ${periodLabel(r.start, r.end)}` }; }
    if (p.range === 'custom') {
      if (!start || !end || !isCalendarDate(start) || !isCalendarDate(end)) return null;
      if (isBefore(end, start)) { setRangeError(END_BEFORE_START); return null; }
      return { start, end, label: periodLabel(start, end) };
    }
    try {
      const r = await resolvePeriodRange({ kind: p.range === 'last' ? 'lastPeriod' : 'thisPeriod' });
      return r.ok && r.data.start && r.data.end ? { start: r.data.start, end: r.data.end, label: r.data.label } : null;
    } catch {
      return null;
    }
  }

  /** Apply new params: the URL, the range, then the tab's data — only the latest request's response is used. */
  async function apply(next: AuditParams, opts: { start?: string | null; end?: string | null } = {}) {
    const mine = ++token.current;
    setParams(next);
    setRangeError(null);
    window.history.replaceState(null, '', `${window.location.pathname}${auditSearch({ ...next, start: next.range === 'custom' ? (opts.start ?? customStart) as CalendarDate | null : null, end: next.range === 'custom' ? (opts.end ?? customEnd) as CalendarDate | null : null })}`);
    setLoading(true);
    try {
      const r = await resolveRange(next, opts.start ?? customStart, opts.end ?? customEnd);
      if (mine !== token.current) return;
      setRange(r);
      if (!r) { setData({}); return; }
      const filters = {
        userId: next.user ?? undefined, contractId: next.contract ?? undefined, clinId: next.clin ?? undefined,
        reasonCode: next.reason ?? undefined, revisionsOnly: next.changed || undefined, startDate: r.start, endDate: r.end,
      };
      let fresh: AuditData;
      if (next.tab === 'entries') {
        const [entries, summary] = await Promise.all([getAuditEntries({ ...filters, page: next.page }), getAuditSummary(filters)]);
        fresh = { entries, summary };
      } else if (next.tab === 'events') {
        fresh = { events: await getAuditPeriodEvents({ userId: filters.userId, startDate: r.start, endDate: r.end }) };
      } else {
        fresh = { admin: await getAdminChanges({ start: r.start, end: r.end, page: next.page }) };
      }
      if (mine !== token.current) return; // a newer change was made meanwhile
      setData(fresh);
    } catch {
      if (mine === token.current) toastError({ title: 'Couldn’t load the audit trail', message: 'Check your connection and try again.' });
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }
  /** §6.1: any filter change resets the page to 1. */
  const change = (patch: Partial<AuditParams>) => { void apply({ ...params, ...patch, page: 1 }); };

  async function chooseContract(contract: string | null) {
    change({ contract, clin: null });
    setClins([]);
    if (!contract) return;
    try { setClins(await getClinsForFilter(contract)); } catch { toastError({ title: 'Couldn’t load CLINs', message: 'Try again.' }); }
  }

  function setCustom(which: 'start' | 'end', value: string | null) {
    const start = which === 'start' ? value : customStart;
    const end = which === 'end' ? value : customEnd;
    if (which === 'start') setCustomStart(value); else setCustomEnd(value);
    void apply({ ...params, range: 'custom', page: 1 }, { start, end });
  }

  async function downloadCsv() {
    if (!range) { toastError({ title: 'Choose dates first', message: 'Pick a valid date range to download.' }); return; }
    await busy.run('csv', async () => {
      const r = await downloadFile(auditCsvHref(params, range.start, range.end), `audit-trail-${range.start}-to-${range.end}.csv`);
      if (!r.ok) toastError({ title: 'Download failed', message: r.error });
    });
  }

  // ── Entry history (the existing revision drawer, retitled) ────────────────────────────────────────────────────────
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<CellRevisionHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  async function openHistory(entry: AuditEntry) {
    setHistoryOpen(true);
    setHistory(null);
    setHistoryLoading(true);
    try {
      setHistory(await getCellRevisionHistory(entry.userId, entry.cellCode, entry.entryDate));
    } catch {
      toastError({ title: 'Couldn’t load the history', message: 'Try again.' });
      setHistoryOpen(false);
    } finally {
      setHistoryLoading(false);
    }
  }

  const when = (d: Date) => formatInstant(new Date(d), workspaceTimezone, 'MMM D, YYYY h:mm A');

  // ── Entries ────────────────────────────────────────────────────────────────────────────────────────────────────
  const entryRows = useMemo(() => data.entries?.entries ?? [], [data.entries]);
  const entryColumns = useMemo<MRT_ColumnDef<AuditEntry>[]>(() => [
    { id: 'entryDate', header: 'Work date', accessorFn: (e) => formatCalendarDate(e.entryDate, 'MMM D, YYYY') },
    { accessorKey: 'userName', header: 'Employee' },
    {
      id: 'code', header: 'Charge code', accessorFn: (e) => e.codeLabel,
      Cell: ({ row: { original: e } }) => (
        <Group gap={6} wrap="nowrap">
          <Text size="sm" ff="monospace">{e.codeLabel}</Text>
          {e.provenance && (
            <Tooltip label={e.provenance} multiline maw={360}>
              <Badge color="signal" size="xs" variant="light" data-testid="audit-imported">Imported</Badge>
            </Tooltip>
          )}
        </Group>
      ),
    },
    numericColumn<AuditEntry>({ id: 'hours', header: 'Hours', accessorFn: (e) => Number(e.hours), Cell: ({ row }) => formatHours(Number(row.original.hours)) }),
    {
      id: 'version', header: 'Version', accessorFn: (e) => e.revisionNumber,
      Cell: ({ row: { original: e } }) => <StatusBadge word={String(e.revisionNumber)} tone={e.revisionNumber >= 2 ? 'warn' : 'dim'} />,
    },
    { id: 'reason', header: 'Reason', accessorFn: (e) => (e.changeReasonCode ? reasonLabel(e.changeReasonCode) : '—') },
    { id: 'comment', header: 'Comment', accessorFn: (e) => e.comment || '—' },
    {
      id: 'entered', header: 'Entered', accessorFn: (e) => when(e.createdAt),
      Cell: ({ row: { original: e } }) => (
        <>
          <Text size="sm">{when(e.createdAt)}</Text>
          <Text size="xs" c={e.provenance ? 'signal' : 'dimmed'}>{e.provenance ?? (e.createdByName ? `by ${e.createdByName}` : '')}</Text>
        </>
      ),
    },
    {
      id: 'history', header: 'History', enableSorting: false,
      Cell: ({ row: { original: e } }) => (
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`History for ${e.userName}, ${formatCalendarDate(e.entryDate, 'MMM D, YYYY')}`} onClick={() => { void openHistory(e); }}>
          <Icons.history size={ICON_SIZE.button} />
        </ActionIcon>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- when() reads workspaceTimezone
  ], [workspaceTimezone]);

  /**
   * The paged tables (entries, admin changes) carry the URL's page only while their tab shows; every table instance runs
   * MRT's out-of-range page check, so a hidden one must never hold — or change — the page.
   */
  const pageOf = (owner: AuditTab) => ({ pageIndex: params.tab === owner ? params.page - 1 : 0, pageSize: PAGE_SIZE });
  function changePage(owner: AuditTab, updater: MRT_Updater<MRT_PaginationState>) {
    if (params.tab !== owner) return;
    const current = { pageIndex: params.page - 1, pageSize: PAGE_SIZE };
    const next = typeof updater === 'function' ? updater(current) : updater;
    if (next.pageIndex !== current.pageIndex) void apply({ ...params, page: next.pageIndex + 1 });
  }
  const entriesTable = useAppTable<AuditEntry>({
    columns: entryColumns,
    data: entryRows,
    hairline: true,
    enableSorting: false,
    manualPagination: true,
    autoResetPageIndex: false, // the page is the URL's (a server-loaded page 3 must stay page 3)
    rowCount: data.entries?.total ?? 0,
    state: { pagination: pageOf('entries') },
    onPaginationChange: (updater) => changePage('entries', updater),
    mantinePaginationProps: { showRowsPerPage: false },
    mantineTableProps: { 'aria-busy': loading || undefined },
    // §6.2: changed (revision ≥ 2) and late rows get the warning edge (globals.css), no fill.
    mantineTableBodyRowProps: ({ row: { original: e } }) => ({
      'data-correction': e.revisionNumber >= 2 ? 'true' : undefined,
      'data-late': isLateEntry(e) ? 'true' : undefined,
    }) as never, // data-* attributes aren't in MRT's row prop type
    emptyState: { title: 'No entries in these dates.', body: 'Try a longer date range or fewer filters.' },
  });

  // ── Events ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const eventRows = useMemo(() => data.events?.events ?? [], [data.events]);
  const eventColumns = useMemo<MRT_ColumnDef<AuditPeriodEvent>[]>(() => [
    { id: 'when', header: 'When', accessorFn: (e) => when(e.createdAt) },
    { accessorKey: 'userName', header: 'Employee' },
    { id: 'period', header: 'Pay period', accessorFn: (e) => periodLabel(e.periodStart, e.periodEnd) },
    {
      id: 'event', header: 'Event', accessorFn: (e) => e.event,
      Cell: ({ row: { original: e } }) => (
        <span data-testid="audit-event">
          <StatusBadge status={e.event} />
          {e.self && SELF_NOTE[e.event] && <Text span size="sm" c="dimmed">{SELF_NOTE[e.event]}</Text>}
          {e.context && <Text size="xs" c="dimmed">{e.context}</Text>}
        </span>
      ),
    },
    { id: 'by', header: 'By', accessorFn: (e) => e.actorName ?? '—' },
    { id: 'comment', header: 'Comment', accessorFn: (e) => e.comment || '—' },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- when() reads workspaceTimezone
  ], [workspaceTimezone]);
  const eventsTable = useAppTable<AuditPeriodEvent>({
    columns: eventColumns,
    data: eventRows,
    hairline: true,
    enableSorting: false,
    mantineTableProps: { 'aria-busy': loading || undefined },
    emptyState: { title: 'No submits, approvals or returns in these dates.' },
  });

  // ── Admin changes ──────────────────────────────────────────────────────────────────────────────────────────────
  const adminRows = useMemo(() => data.admin?.rows ?? [], [data.admin]);
  const adminColumns = useMemo<MRT_ColumnDef<AdminChangeEntry>[]>(() => [
    { id: 'when', header: 'When', accessorFn: (r) => when(r.createdAt) },
    { accessorKey: 'change', header: 'Change' },
    { accessorKey: 'details', header: 'Details' },
    { id: 'by', header: 'By', accessorFn: (r) => r.byName ?? '—' },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- when() reads workspaceTimezone
  ], [workspaceTimezone]);
  const adminTable = useAppTable<AdminChangeEntry>({
    columns: adminColumns,
    data: adminRows,
    hairline: true,
    enableSorting: false,
    manualPagination: true,
    autoResetPageIndex: false,
    rowCount: data.admin?.total ?? 0,
    state: { pagination: pageOf('admin') },
    onPaginationChange: (updater) => changePage('admin', updater),
    mantinePaginationProps: { showRowsPerPage: false },
    mantineTableProps: { 'aria-busy': loading || undefined },
    emptyState: { title: 'No admin changes in these dates.' },
  });

  const tab = params.tab;
  const onEntries = tab === 'entries';
  const summary = data.summary;
  const rangeOptions = [
    { value: 'last30', label: `Last 30 days · ${periodLabel(last30Days(workspaceToday).start, workspaceToday)}` },
    { value: 'last', label: 'Last pay period' },
    { value: 'this', label: 'This pay period' },
    { value: 'custom', label: 'Custom dates…' },
  ];

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every hour entry and every change to it, and every submit, approval and return — who, when, and why."
        actions={<Button variant="default" {...busy.props('csv', { icon: <Icons.download size={ICON_SIZE.button} /> })} onClick={() => { void downloadCsv(); }}>Download CSV</Button>}
      />

      <Group align="flex-end" gap="md" wrap="wrap" mb="md" data-testid="audit-filters">
        <Select label="Dates" w={280} allowDeselect={false} data={rangeOptions} value={params.range}
          onChange={(v) => change({ range: (v as AuditRange) ?? 'last30' })} />
        {params.range === 'custom' && (
          <>
            <DateInput label="Start date" value={customStart} onChange={(v) => setCustom('start', v)} w={150} />
            <DateInput label="End date" value={customEnd} onChange={(v) => setCustom('end', v)} w={150} error={rangeError} />
          </>
        )}
        {tab !== 'admin' && (
          <Select label="Employee" w={200} searchable allowDeselect={false}
            data={[{ value: '', label: 'Everyone' }, ...users.map((u) => ({ value: u.id, label: u.fullName }))]}
            value={params.user ?? ''} onChange={(v) => change({ user: v || null })} />
        )}
        {onEntries && (
          <>
            <Select label="Contract" w={220} searchable allowDeselect={false}
              data={[{ value: '', label: 'All contracts' }, ...contracts.map((c) => ({ value: c.id, label: c.name }))]}
              value={params.contract ?? ''} onChange={(v) => { void chooseContract(v || null); }} />
            {params.contract && (
              <Select label="CLIN" w={180} allowDeselect={false}
                data={[{ value: '', label: 'All CLINs' }, ...clins.map((c) => ({ value: c.id, label: `${c.clinNumber}${c.description ? ` — ${c.description}` : ''}` }))]}
                value={params.clin ?? ''} onChange={(v) => change({ clin: v || null })} />
            )}
            <Select label="Reason" w={220} allowDeselect={false} data={REASON_OPTIONS} value={params.reason ?? ''} onChange={(v) => change({ reason: v || null })} />
            <Checkbox label="Changed entries only" mb={8} checked={params.changed} onChange={(e) => change({ changed: e.currentTarget.checked })} />
          </>
        )}
      </Group>

      <Tabs value={tab} onChange={(v) => { if (v && v !== tab) change({ tab: v as AuditTab }); }}>
        <Tabs.List mb="md">
          <Tabs.Tab value="entries">Hour entries</Tabs.Tab>
          <Tabs.Tab value="events">Timesheet events</Tabs.Tab>
          {isAdmin && <Tabs.Tab value="admin">Admin changes</Tabs.Tab>}
        </Tabs.List>

        <Tabs.Panel value="entries">
          {onEntries && (
            <Stack gap="sm">
              <SimpleGrid cols={{ base: 2, md: 4 }} data-testid="audit-summary">
                {([['Entries in this view', summary?.entries], ['Changed after first entry', summary?.changed], ['Entered late', summary?.late], ['People', summary?.people]] as const).map(([label, n]) => (
                  <Paper key={label} withBorder p="md" radius="md">
                    <Text size="xl" fw={700}>{n === undefined ? '—' : formatCount(n)}</Text>
                    <Text size="xs" c="dimmed">{label}</Text>
                  </Paper>
                ))}
              </SimpleGrid>
              <div data-testid="audit-entries"><MantineReactTable table={entriesTable} /></div>
              <Text size="xs" c="dimmed" data-testid="audit-legend">
                <span aria-hidden="true" style={{ display: 'inline-block', width: 3, height: 12, background: 'var(--audit-correction-edge)', marginRight: 6, verticalAlign: -1 }} />
                Changed or entered late
              </Text>
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="events">
          {tab === 'events' && (
            <Stack gap="xs">
              {data.events?.truncated && (
                <Text size="xs" c="dimmed" data-testid="audit-events-truncated">Showing the first 500 events. Narrow your filters for more.</Text>
              )}
              <div data-testid="audit-events"><MantineReactTable table={eventsTable} /></div>
            </Stack>
          )}
        </Tabs.Panel>

        {isAdmin && (
          <Tabs.Panel value="admin">
            {tab === 'admin' && <div data-testid="audit-admin"><MantineReactTable table={adminTable} /></div>}
          </Tabs.Panel>
        )}
      </Tabs>

      <Drawer opened={historyOpen} onClose={() => setHistoryOpen(false)} position="right" size="lg" title="Entry history">
        <Stack>
          {historyLoading && <Text c="dimmed" size="sm" role="status">Loading the history…</Text>}
          {!historyLoading && !history && <Text c="dimmed" size="sm">No history found.</Text>}
          {history && (
            <>
              <Paper withBorder p="sm">
                <Group>
                  <Text size="sm"><strong>Employee:</strong> {history.userName}</Text>
                  <Text size="sm"><strong>Work date:</strong> {formatCalendarDate(history.entryDate, 'ddd MMM D, YYYY')}</Text>
                  <Text size="sm"><strong>Charge code:</strong> {history.codeLabel}</Text>
                  <Text size="sm"><strong>Contract:</strong> {history.contractName ?? 'Indirect'}{history.kind === 'charge' && history.clinNumber ? ` · CLIN ${history.clinNumber}` : ''}</Text>
                </Group>
              </Paper>
              <Timeline active={history.revisions.length - 1} bulletSize={24} lineWidth={2}>
                {[...history.revisions].reverse().map((rev, i) => (
                  <Timeline.Item key={rev.id} title={<Text fw={600} size="sm">Version {rev.revisionNumber} · {formatHours(Number(rev.hours))} hours{i === 0 ? ' · current' : ''}</Text>}>
                    <Stack gap={2} mt={2}>
                      {(rev.changeReasonCode || rev.comment) && (
                        <Text size="xs">{[rev.changeReasonCode ? reasonLabel(rev.changeReasonCode) : null, rev.comment ? `“${rev.comment}”` : null].filter(Boolean).join(' · ')}</Text>
                      )}
                      {rev.provenance
                        ? <Text size="xs" c="signal" data-testid="revision-imported">{rev.provenance}</Text>
                        : <Text size="xs" c="dimmed">Entered {formatInstant(rev.createdAt, workspaceTimezone, 'MMM D, YYYY h:mm A')}{rev.createdByName ? ` by ${rev.createdByName}` : ''}</Text>}
                    </Stack>
                  </Timeline.Item>
                ))}
              </Timeline>
              <Text size="xs" c="dimmed">Entries are never overwritten: each change adds a version with its reason.</Text>
            </>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
