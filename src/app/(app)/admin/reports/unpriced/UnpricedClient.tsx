'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Anchor, Button, Group, Paper, Select, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { PageHeader } from '@/components/ui/PageHeader';
import { Notice } from '@/components/ui/Notice';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PeriodPresetSelect, CUSTOM_PRESET, periodSelectionReady, type PeriodSelection } from '@/components/ui/PeriodPresetSelect';
import { useBusy } from '@/components/ui/useBusy';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { useAppTable, numericColumn } from '@/components/table/mrtDefaults';
import { resolvePeriodRange } from '@/server/actions/periods';
import type { OverlapRow, UnpricedGroup, UnpricedReport } from '@/server/internal/cost-basis';
import { unpricedFiltersQuery, type UnpricedFilterInput } from '@/lib/unpriced-filters';
import { CURRENT_RATES_NOTE, UNPRICED_REPORT_HREF } from '@/lib/cost-labels';
import { formatCount, formatDate, formatHours } from '@/lib/format';
import { downloadFile } from '@/lib/download';
import { runAction } from '@/lib/run-action';
import type { CalendarDate } from '@/lib/calendar-date';
import classes from '../../contracts/Contracts.module.css';

/** Fix routing (blueprint §6): where each kind of problem is fixed. */
export function fixLink(g: Pick<UnpricedGroup, 'fix' | 'employeeName'>): { label: string; href: string } {
  if (g.fix.kind === 'set-code-category') return { label: 'Set category on code', href: `/admin/charge-codes?code=${g.fix.chargeCodeId}` };
  if (g.fix.kind === 'assign-category') {
    return { label: `Assign ${g.employeeName.split(' ')[0]} a category`, href: `/admin/assignments?${new URLSearchParams({ tab: 'labor-categories', userId: g.fix.userId })}` };
  }
  return { label: 'Review overlap', href: reviewOverlapHref(g.fix.userId, g.fix.assignmentIds) };
}

export function reviewOverlapHref(userId: string, assignmentIds: string[]): string {
  return `/admin/assignments?${new URLSearchParams({ tab: 'labor-categories', userId, assignments: assignmentIds.join(',') })}`;
}

const where = (g: UnpricedGroup) =>
  g.chargeCode ?? `${g.contractName} CLIN ${g.clinNumber}${g.slinNumber ? ` SLIN ${g.slinNumber}` : ''}`;
const dates = (first: string, last: string) => (first === last ? formatDate(first as CalendarDate) : `${formatDate(first as CalendarDate)} – ${formatDate(last as CalendarDate)}`);

const PRESETS = [
  { value: 'allTime', label: 'All time' },
  { value: 'lastPeriod', label: 'Last pay period' },
  { value: 'thisPeriod', label: 'This pay period' },
  { value: 'thisMonth', label: 'This month' },
];

function OverlapTable({ pairs }: { pairs: OverlapRow[] }) {
  return (
    <Paper withBorder radius="md">
      <Table.ScrollContainer minWidth={720}>
        <Table>
          <Table.Thead>
            <Table.Tr><Table.Th>Employee</Table.Th><Table.Th>Level</Table.Th><Table.Th>CLIN / SLIN</Table.Th><Table.Th>Categories</Table.Th><Table.Th>Overlap</Table.Th><Table.Th>Fix</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {pairs.map((p) => {
              const from = p.a.effectiveDate > p.b.effectiveDate ? p.a.effectiveDate : p.b.effectiveDate;
              const ends = [p.a.endDate, p.b.endDate].filter((d): d is string => !!d).sort();
              return (
                <Table.Tr key={`${p.a.assignmentId}:${p.b.assignmentId}`}>
                  <Table.Td>{p.employeeName}</Table.Td>
                  <Table.Td>{p.level === 'slin' ? 'SLIN' : 'CLIN'}</Table.Td>
                  <Table.Td>{p.slinNumber ? `CLIN ${p.clinNumber} SLIN ${p.slinNumber}` : `CLIN ${p.clinNumber}`}</Table.Td>
                  <Table.Td>{p.a.lcatCode} and {p.b.lcatCode}</Table.Td>
                  <Table.Td>{formatDate(from as CalendarDate)} – {ends[0] ? formatDate(ends[0] as CalendarDate) : 'open'}</Table.Td>
                  <Table.Td><Button component={Link} href={reviewOverlapHref(p.userId, [p.a.assignmentId, p.b.assignmentId])} variant="default" size="compact-sm">Review overlap</Button></Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}

export function UnpricedClient({ report, filters, period, contracts }: {
  report: UnpricedReport;
  filters: UnpricedFilterInput;
  period?: string;
  contracts: Array<{ id: string; name: string; contractNumber: string }>;
}) {
  const router = useRouter();
  const busy = useBusy();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<PeriodSelection>(() => (
    filters.startDate || filters.endDate
      ? { preset: PRESETS.some((p) => p.value === period) ? period! : CUSTOM_PRESET, start: (filters.startDate ?? null) as CalendarDate | null, end: (filters.endDate ?? null) as CalendarDate | null }
      : { preset: 'allTime', start: null, end: null }
  ));
  const [periodError, setPeriodError] = useState<string | null>(null);

  const go = (next: UnpricedFilterInput, nextPeriod?: string) => {
    const q = new URLSearchParams(unpricedFiltersQuery(next));
    if (nextPeriod && nextPeriod !== CUSTOM_PRESET && nextPeriod !== 'allTime') q.set('period', nextPeriod);
    const s = q.toString();
    router.push(s ? `${UNPRICED_REPORT_HREF}?${s}` : UNPRICED_REPORT_HREF);
  };

  async function changePeriod(next: PeriodSelection) {
    setSelection(next);
    setPeriodError(null);
    if (next.preset === 'allTime') return go({ ...filters, startDate: undefined, endDate: undefined });
    if (next.preset === CUSTOM_PRESET) {
      if (periodSelectionReady(next)) go({ ...filters, startDate: next.start!, endDate: next.end! });
      return;
    }
    const result = await runAction(resolvePeriodRange({ kind: next.preset as 'lastPeriod' | 'thisPeriod' | 'thisMonth' }), { silent: true });
    if (!result.ok) { setPeriodError(result.error); return; }
    go({ ...filters, startDate: result.data.start ?? undefined, endDate: result.data.end ?? undefined }, next.preset);
  }

  async function download() {
    setDownloadError(null);
    const q = unpricedFiltersQuery(filters);
    const result = await downloadFile(`/api/reports/unpriced-xlsx${q ? `?${q}` : ''}`, 'unpriced-hours.xlsx');
    if (!result.ok) setDownloadError(result.error);
  }

  const columns = useMemo<MRT_ColumnDef<UnpricedGroup>[]>(() => [
    {
      id: 'reason', header: 'What\'s wrong', accessorFn: (g) => (g.reason === 'conflict' ? 'Overlapping categories' : 'No category'),
      Cell: ({ row }) => (row.original.reason === 'conflict'
        ? <StatusBadge word="Overlapping categories" tone="bad" />
        : <StatusBadge word="No category" tone="warn" />),
    },
    { id: 'employee', header: 'Employee', accessorFn: (g) => g.employeeName },
    { id: 'where', header: 'Where', accessorFn: (g) => where(g), Cell: ({ row }) => <span className={row.original.chargeCode ? classes.mono : undefined}>{where(row.original)}</span> },
    numericColumn<UnpricedGroup>({ id: 'hours', header: 'Hours', accessorFn: (g) => g.hours, Cell: ({ row }) => formatHours(row.original.hours) }),
    { id: 'dates', header: 'Dates', accessorFn: (g) => g.first, Cell: ({ row }) => <span className={classes.sub}>{dates(row.original.first, row.original.last)}</span> },
    {
      id: 'fix', header: 'Fix', enableSorting: false,
      Cell: ({ row }) => { const f = fixLink(row.original); return <Button component={Link} href={f.href} variant="default" size="compact-sm" data-testid="fix-link">{f.label}</Button>; },
    },
  ], []);

  const table = useAppTable<UnpricedGroup>({
    columns,
    data: report.groups,
    hairline: true,
    compact: report.groups.length <= 25,
    getRowId: (g) => g.key,
    enableGlobalFilter: false,
    enableTopToolbar: false,
  });

  const filtered = !!(filters.startDate || filters.endDate || filters.contractId || filters.clinId || filters.slinId || filters.reason);
  const nothing = report.groups.length === 0 && report.unattachedOverlaps.length === 0 && report.outOfViewOverlaps.length === 0;

  return (
    <>
      <PageHeader
        breadcrumb={<><Anchor component={Link} href="/admin/reports" size="sm">Downloads</Anchor> › Unpriced hours</>}
        title="Unpriced hours"
        description={<>Hours that have no labor-category rate, so contract costs leave them out. Each row is one thing to fix.<div style={{ fontSize: 'var(--mantine-font-size-xs)', marginTop: 2 }}>{CURRENT_RATES_NOTE}</div></>}
        actions={(
          <Button variant="default" {...busy.props('excel', { icon: <Icons.download size={ICON_SIZE.button} /> })} onClick={() => { void busy.run('excel', download); }}>
            Download Excel
          </Button>
        )}
      />
      {downloadError && <Alert color="red" role="alert" mb="md" data-testid="download-error">{downloadError}</Alert>}

      <Paper withBorder radius="md" className={classes.strip} style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }} data-testid="unpriced-strip">
        <div><div className={classes.stripValue}>{formatHours(report.totals.hours)}</div><div className={classes.stripLabel}>Unpriced hours</div></div>
        <div><div className={classes.stripValue}>{formatCount(report.totals.groups)}</div><div className={classes.stripLabel}>Things to fix</div></div>
        <div><div className={classes.stripValue}>{formatCount(report.totals.employees)}</div><div className={classes.stripLabel}>Employees affected</div></div>
      </Paper>

      <Group align="flex-end" gap="md" mb="md" wrap="wrap">
        <Select
          label="Contract" w={260} allowDeselect={false}
          data={[{ value: '', label: 'All contracts' }, ...contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.contractNumber})` }))]}
          value={filters.contractId ?? ''}
          onChange={(v) => go({ ...filters, contractId: v || undefined, clinId: undefined, slinId: undefined }, selection.preset)}
        />
        <PeriodPresetSelect label="Period" presets={PRESETS} value={selection} onChange={(v) => { void changePeriod(v); }} w={220} />
        <Switch
          label="Show overlaps only" mb={8}
          checked={filters.reason === 'conflict'}
          onChange={(e) => { const on = e.currentTarget.checked; go({ ...filters, reason: on ? 'conflict' : undefined }, selection.preset); }}
        />
      </Group>
      {periodError && <Alert color="red" role="alert" mb="md">{periodError}</Alert>}

      {report.truncated && (
        <Notice tone="info">Showing the 1,000 largest groups. Download Excel for everything.</Notice>
      )}

      {nothing ? (
        <Paper withBorder radius="md" p="xl" data-testid="unpriced-empty">
          <Text ta="center">No unpriced hours. Every recorded hour has a labor-category rate.</Text>
        </Paper>
      ) : report.groups.length > 0 ? (
        <MantineReactTable table={table} />
      ) : (
        <Text mb="sm" data-testid="unpriced-only-overlaps">
          {filtered ? 'No unpriced hours in this view.' : 'No unpriced hours yet.'}
          {report.unattachedOverlaps.length > 0 && ' These overlapping assignments will leave hours unpriced when time is recorded in their overlap.'}
        </Text>
      )}

      {report.unattachedOverlaps.length > 0 && (
        <Stack gap="xs" mt="lg" data-testid="unattached-overlaps">
          <Title order={2} size="h4">Overlapping assignments (no hours affected yet)</Title>
          <OverlapTable pairs={report.unattachedOverlaps} />
        </Stack>
      )}
      {filtered && report.outOfViewOverlaps.length > 0 && (
        <Stack gap="xs" mt="lg" data-testid="out-of-view-overlaps">
          <Title order={2} size="h4">Overlapping assignments with no unpriced hours in this view</Title>
          <OverlapTable pairs={report.outOfViewOverlaps} />
        </Stack>
      )}
    </>
  );
}
