'use client';

import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Accordion, Alert, Button, Group, Paper, Select, Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { PageHeader } from '@/components/ui/PageHeader';
import { Notice } from '@/components/ui/Notice';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useBusy } from '@/components/ui/useBusy';
import { CUSTOM_PRESET, PeriodPresetSelect, periodSelectionReady, type PeriodSelection } from '@/components/ui/PeriodPresetSelect';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { useAppTable, numericColumn } from '@/components/table/mrtDefaults';
import {
  getPayrollExportPreview,
  generatePayrollExportCSV,
  type PayrollPreview,
  type PayrollPreviewRow,
} from '@/server/actions/payroll-export';
import { runAction, type RunResult } from '@/lib/run-action';
import { saveBlob } from '@/lib/download';
import { toastSuccess } from '@/lib/toast';
import { formatCount, formatHours } from '@/lib/format';
import { calendarDayOf, formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { periodLabel } from '@/lib/timesheet/labels';
import type { NotIncluded } from '@/lib/payroll/not-included';
import type { ActionResult } from '@/lib/action-result';

/**
 * Payroll export (feature-plan-ux-approvals-payroll.md §4.2): pick a pay period (kit presets; custom dates seeded from
 * the current range), the preview runs on every complete change (a stale response is dropped by a request token), the
 * F10 warning sits above the downloads, "not in this file" says who is missing and why, and the downloads refuse in
 * their handler unless the preview is READY for the CURRENT range (F4 — the flagged people are always seen first).
 */

export interface PayrollPresets {
  last: { start: CalendarDate; end: CalendarDate; label: string };
  current: { start: CalendarDate; end: CalendarDate; label: string };
  previous: { start: CalendarDate; end: CalendarDate; label: string };
}

const FORMAT_OPTIONS = [
  { value: 'adp', label: 'ADP Workforce Now' },
  { value: 'paychex', label: 'Paychex Flex' },
  { value: 'gusto', label: 'Gusto' },
  { value: 'custom', label: 'Custom (all columns)' },
];
const DEFAULT_FORMAT = 'adp';
export const FORMAT_KEY = 'cp.payrollFormat';
const FORMAT_EVENT = 'cp-payroll-format';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The remembered format, validated against the options (anything else → the default). */
function readFormat(): string {
  try {
    const v = window.localStorage.getItem(FORMAT_KEY);
    return FORMAT_OPTIONS.some((f) => f.value === v) ? v! : DEFAULT_FORMAT;
  } catch {
    return DEFAULT_FORMAT;
  }
}
function subscribeFormat(cb: () => void) {
  window.addEventListener('storage', cb);
  window.addEventListener(FORMAT_EVENT, cb);
  return () => { window.removeEventListener('storage', cb); window.removeEventListener(FORMAT_EVENT, cb); };
}

type PreviewState = { range: string; result: ActionResult<PayrollPreview> | RunResult<PayrollPreview> | null };

const WHY: Record<NotIncluded['status'], (n: NotIncluded, day: (iso: string) => string) => string> = {
  submitted: () => '— waiting for approval',
  rejected: (n, day) => `— returned${n.returnedAt ? ` ${day(n.returnedAt)}` : ''}, not resubmitted`,
  draft: () => '— not submitted',
  none: () => '— not started',
};

export function PayrollExportClient({ presets, initialPreview, timeZone }: {
  presets: PayrollPresets;
  initialPreview: ActionResult<PayrollPreview>;
  timeZone: string;
}) {
  const busy = useBusy();
  const loadingHintId = useId();
  const refusedId = useId();
  const failedId = useId();
  /** Polite live region (fix round 1, L7): "Preview updated for {range}" when a chosen range's preview lands. */
  const [announcement, setAnnouncement] = useState('');
  const format = useSyncExternalStore(subscribeFormat, readFormat, () => DEFAULT_FORMAT);
  const setFormat = (v: string | null) => {
    if (!v) return;
    try { window.localStorage.setItem(FORMAT_KEY, v); } catch { /* private mode: the choice lasts this view only */ }
    window.dispatchEvent(new Event(FORMAT_EVENT));
  };

  // The selection always carries a start and end (every preset's), so "Custom dates…" starts from the current range.
  const [selection, setSelection] = useState<PeriodSelection>({ preset: 'last', start: presets.last.start, end: presets.last.end });
  const rangeOf = (sel: PeriodSelection) => (sel.start && sel.end ? `${sel.start}|${sel.end}` : '');
  const rangeKey = periodSelectionReady(selection) ? rangeOf(selection) : '';
  const [preview, setPreview] = useState<PreviewState>({ range: rangeOf({ preset: 'last', start: presets.last.start, end: presets.last.end }), result: initialPreview });
  const token = useRef(0);

  function choose(next: PeriodSelection) {
    const preset = next.preset as keyof PayrollPresets | typeof CUSTOM_PRESET;
    const sel: PeriodSelection = preset !== CUSTOM_PRESET && preset in presets && next.preset !== selection.preset
      ? { preset: next.preset, start: presets[preset as keyof PayrollPresets].start, end: presets[preset as keyof PayrollPresets].end }
      : next;
    setSelection(sel);
    if (!periodSelectionReady(sel) || !sel.start || !sel.end) return;
    const key = rangeOf(sel);
    const mine = ++token.current;
    setPreview({ range: key, result: null });
    setAnnouncement('');
    const { start, end } = sel;
    void (async () => {
      const result = await runAction(getPayrollExportPreview({ periodStart: start, periodEnd: end }), { silent: true });
      if (mine !== token.current) return; // a newer range was chosen meanwhile — drop it before any setState
      if (!result.ok) { setPreview({ range: key, result }); return; } // shown inline (role="alert"); the downloads stay blocked
      setPreview({ range: key, result });
      setAnnouncement(`Preview updated for ${periodLabel(start, end)}`);
    })();
  }

  const current = preview.range === rangeKey ? preview.result : null;
  const loading = rangeKey !== '' && preview.range === rangeKey && preview.result === null;
  const ready = current?.ok && current.data.status === 'ready' ? current.data : null;
  const refused = current?.ok && current.data.status === 'refused' ? current.data : null;
  const failed = current && !current.ok ? current.error : null;
  const canDownload = !!ready;
  const employees: PayrollPreviewRow[] = ready?.employees ?? [];
  const flagged = employees.filter((e) => e.otBasisIncludesUnapprovedDays);
  const notIncluded = ready?.notIncluded ?? [];
  const missingPeople = new Set(notIncluded.map((n) => n.userId)).size;
  const partly = notIncluded.some((n) => n.partlyIncluded);
  const day = (iso: string) => formatCalendarDate(calendarDayOf(new Date(iso), timeZone), 'MMM D');

  async function download(kind: string) {
    // F4, in the handler: only a READY preview of the CURRENT range (aria-disabled alone doesn't stop a click).
    if (!(preview.range === rangeKey && current?.ok && current.data.status === 'ready') || !selection.start || !selection.end) return;
    await busy.run(`download:${kind}`, async () => {
      const result = await runAction(generatePayrollExportCSV({
        periodStart: selection.start!, periodEnd: selection.end!, format: kind as 'adp' | 'paychex' | 'gusto' | 'custom' | 'daily-hours',
      }), { errorTitle: 'Export failed' });
      if (!result.ok) return;
      saveBlob(new Blob([result.data.csvContent], { type: 'text/csv;charset=utf-8;' }), result.data.filename);
      toastSuccess({
        title: 'Export downloaded',
        message: `${result.data.employeeCount} employees, ${formatHours(result.data.totalPaidHours)} paid hours`
          + (result.data.flaggedCount > 0 ? ` — ${result.data.flaggedCount} flagged` : ''),
      });
    }, { group: 'download' });
  }

  const notColumns = useMemo<MRT_ColumnDef<NotIncluded>[]>(() => [
    { id: 'name', header: 'Name', accessorFn: (n) => n.employeeName, Cell: ({ row }) => <Text fw={600} size="sm" span>{row.original.employeeName}</Text> },
    {
      id: 'why', header: 'Why', accessorFn: (n) => n.status,
      Cell: ({ row: { original: n } }) => (
        <Group gap={6} wrap="nowrap">
          {n.status === 'none' ? <StatusBadge word="Not started" tone="dim" /> : <StatusBadge status={n.status} />}
          <Text size="sm" c="dimmed" span>
            {WHY[n.status](n, day)}{n.partlyIncluded ? ' · partly included' : ''}
          </Text>
        </Group>
      ),
    },
    numericColumn<NotIncluded>({ id: 'hours', header: 'Hours', accessorFn: (n) => n.hoursInRange, Cell: ({ row }) => formatHours(row.original.hoursInRange) }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- day only reads timeZone
  ], [timeZone]);
  const notTable = useAppTable<NotIncluded>({
    columns: notColumns,
    data: notIncluded,
    hairline: true,
    compact: notIncluded.length <= 25,
    enableSorting: false,
    enableTopToolbar: false,
    getRowId: (n) => `${n.userId}|${n.periodStart}`,
    mantineTableProps: { 'aria-label': 'People not in this file' },
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row: { original: n } }) => (n.canReview && n.periodId
      ? <Button component={Link} href={`/admin/approvals?review=${n.periodId}`} size="xs" variant="default" aria-label={`Review ${n.employeeName}’s timesheet`}>Review</Button>
      : null),
  });

  const totals = ready?.totals;
  const inColumns = useMemo<MRT_ColumnDef<PayrollPreviewRow>[]>(() => [
    {
      id: 'employee', header: 'Employee', accessorFn: (e) => e.employeeName,
      Cell: ({ row: { original: e } }) => (
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={500} span>{e.employeeName}</Text>
          {e.otBasisIncludesUnapprovedDays && <StatusBadge word="Flagged" tone="warn" />}
        </Group>
      ),
      Footer: () => (totals ? `${formatCount(totals.people)} ${totals.people === 1 ? 'person' : 'people'}` : ''),
    },
    { id: 'flsa', header: 'FLSA', accessorFn: (e) => (e.flsaExempt ? 'Exempt' : 'Non-exempt'), Cell: ({ cell }) => <Text size="sm" c="dimmed" span>{cell.getValue<string>()}</Text> },
    numericColumn<PayrollPreviewRow>({ id: 'regular', header: 'Regular', accessorFn: (e) => e.regularHours, Cell: ({ row }) => formatHours(row.original.regularHours), Footer: () => (totals ? formatHours(totals.regular) : '') }),
    numericColumn<PayrollPreviewRow>({
      id: 'overtime', header: 'Overtime', accessorFn: (e) => e.overtimeHours,
      Cell: ({ row }) => (row.original.flsaExempt ? <Text size="sm" c="dimmed" span>—</Text> : formatHours(row.original.overtimeHours)),
      Footer: () => (totals ? formatHours(totals.overtime) : ''),
    }),
    numericColumn<PayrollPreviewRow>({ id: 'leave', header: 'Leave', accessorFn: (e) => e.paidLeave, Cell: ({ row }) => formatHours(row.original.paidLeave), Footer: () => (totals ? formatHours(totals.paidLeave) : '') }),
    numericColumn<PayrollPreviewRow>({ id: 'total', header: 'Total', accessorFn: (e) => e.totalPaidHours, Cell: ({ row }) => formatHours(row.original.totalPaidHours), Footer: () => (totals ? formatHours(totals.totalPaid) : '') }),
  ], [totals]);
  const inTable = useAppTable<PayrollPreviewRow>({
    columns: inColumns,
    data: employees,
    hairline: true,
    compact: employees.length <= 25,
    enableSorting: false,
    enableTopToolbar: false,
    getRowId: (e) => e.userId,
    enableTableFooter: employees.length > 0,
    emptyState: { title: 'No approved hours in this pay period.', body: 'Only approved timesheets are exported.' },
  });

  const downloadBlocked = !canDownload;
  // Why the downloads are blocked, read with them (L7): loading, the refusal, or the failure.
  const describedBy = loading ? loadingHintId : refused ? refusedId : failed ? failedId : undefined;
  return (
    <>
      <PageHeader
        title="Payroll export"
        description="Approved hours for a pay period, formatted for your payroll system, with weekly overtime worked out."
      />

      <Paper withBorder radius="md" p="md" mb="md">
        <Group align="flex-end" gap="lg" wrap="wrap">
          <PeriodPresetSelect
            label="Pay period"
            w={300}
            presets={[
              { value: 'last', label: `Last pay period · ${presets.last.label}` },
              { value: 'current', label: `This pay period · ${presets.current.label}` },
              { value: 'previous', label: presets.previous.label },
            ]}
            value={selection}
            onChange={choose}
          />
          <Select label="Format" w={220} allowDeselect={false} data={FORMAT_OPTIONS} value={format} onChange={setFormat} />
          <Stack gap={4} ml="auto">
            {/* A11 (F10): the warning sits ABOVE the downloads. */}
            {flagged.length > 0 && (
              <div data-testid="payroll-flagged">
                <Notice>
                  <b>Overtime uses unapproved days.</b> These employees&apos; overtime counts hours from unapproved days
                  earlier in the same workweek. Their figures may change once those timesheets are approved:{' '}
                  <b>{flagged.map((e) => e.employeeName).join(', ')}</b>
                </Notice>
              </div>
            )}
            <Group gap="sm">
              <WriteButton
                {...busy.props('download:csv', { group: 'download', blocked: downloadBlocked })}
                aria-describedby={describedBy}
                onClick={() => { void download(format); }}
                data-testid="payroll-download"
              >
                Download CSV
              </WriteButton>
              <WriteButton
                variant="default"
                {...busy.props('download:daily-hours', { group: 'download', blocked: downloadBlocked })}
                aria-describedby={describedBy}
                onClick={() => { void download('daily-hours'); }}
                data-testid="payroll-download-daily"
              >
                Download daily detail
              </WriteButton>
            </Group>
            {loading && <Text size="xs" c="dimmed" id={loadingHintId} role="status" data-testid="payroll-loading">Loading preview…</Text>}
          </Stack>
        </Group>
      </Paper>

      <VisuallyHidden role="status" aria-live="polite" data-testid="payroll-announcement">{announcement}</VisuallyHidden>
      {failed && <Alert color="red" role="alert" mb="md" id={failedId} data-testid="payroll-preview-error">{failed}</Alert>}
      {refused && (
        <div id={refusedId} data-testid="payroll-refused">
          <Notice action={refused.reason === 'workweek-unset'
            ? { label: 'Set the workweek start day', href: '/settings/workspace' }
            : { label: 'Set pay types on Indirect codes', href: '/admin/charge-codes?tab=indirect' }}>
            {refused.message}
          </Notice>
        </div>
      )}

      {ready && (
        <>
          {missingPeople > 0 && (
            <>
              <Notice>
                <b>{formatCount(missingPeople)} {missingPeople === 1 ? 'person isn’t' : 'people aren’t'}{partly ? ' fully' : ''} in this file.</b> Only approved timesheets are exported.
              </Notice>
              <div data-testid="payroll-not-included"><MantineReactTable table={notTable} /></div>
            </>
          )}

          <Title order={2} size="h4" mt="lg" mb="xs">In this file</Title>
          <div data-testid="payroll-in-file"><MantineReactTable table={inTable} /></div>

          <Accordion mt="md" variant="contained" data-testid="payroll-how">
            <Accordion.Item value="how">
              <Accordion.Control>How overtime is worked out</Accordion.Control>
              <Accordion.Panel>
                <Text size="sm" maw="72ch">
                  Overtime is hours worked over 40 in your workweek (starts {DAY_NAMES[ready.workweekStartDay]}), for
                  non-exempt employees only. Leave doesn&apos;t count toward the 40. Weeks that cross the pay-period edge
                  use the days on both sides. Exempt employees&apos; hours over 40 are listed as uncompensated overtime in
                  the Custom and daily-detail files. Partial-day deductions for exempt employees aren&apos;t calculated;
                  review those in your payroll system.
                </Text>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </>
      )}
      {!ready && !loading && !failed && !refused && rangeKey === '' && (
        <Text size="sm" c="dimmed">Choose a start and end date to see the preview.</Text>
      )}
    </>
  );
}
