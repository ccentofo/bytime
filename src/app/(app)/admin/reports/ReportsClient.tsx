'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button, Paper, Select, Stack, Text } from '@mantine/core';
import { addDays, isBefore, isCalendarDate, startOfMonth, type CalendarDate } from '@/lib/calendar-date';
import { resolvePeriodRange, type PeriodOption, type PeriodPreset } from '@/server/actions/periods';
import { PageHeader } from '@/components/ui/PageHeader';
import { useBusy } from '@/components/ui/useBusy';
import {
  CUSTOM_PRESET, PeriodPresetSelect, periodSelectionError, periodSelectionReady, type PeriodSelection,
} from '@/components/ui/PeriodPresetSelect';
import { CURRENT_RATES_NOTE, UNPRICED_REPORT_HREF } from '@/lib/cost-labels';
import { downloadFile, type DownloadOptions } from '@/lib/download';
import { runAction } from '@/lib/run-action';
import { formatCount, formatHours } from '@/lib/format';
import { periodLabel } from '@/lib/timesheet/labels';
import classes from './Reports.module.css';

/**
 * Downloads (feature-plan-ux-kit-contracts.md §4.5): one panel of rows — what the report is, its inputs, its buttons.
 * Every download goes through fetch (downloadFile), never window.open. Busy state per button (useBusy composite keys:
 * a row's buttons block each other, never another row's); each row has its own inline error, cleared by the next
 * attempt or an input change. A 422 (no hours in range) shows the route's message in place. Neutral buttons: the PDF
 * is the one primary, the rest are outlined.
 */

type Row = 'pdf' | 'costs' | 'summary' | 'periodCost' | 'unpriced';

type FilterOptions = {
  users: Array<{ id: string; fullName: string; email: string }>;
  contracts: Array<{ id: string; name: string; contractNumber: string; startDate: CalendarDate | null }>;
};

type Props = {
  filterOptions: FilterOptions;
  role: 'admin' | 'supervisor' | 'employee';
  /** This pay period and 24 back, oldest first (getPeriodOptions, server-resolved across schedule changes). */
  periodOptions: PeriodOption[];
  /** The workspace's today. */
  today: CalendarDate;
  /** All-time unpriced totals — admins only (null for a supervisor, who never loads them). */
  unpriced: { hours: number; groups: number; employees: number } | null;
};

const PERIOD_COUNTS = ['3', '6', '12'];
const PDF_MESSAGES: DownloadOptions = { messages: { 404: "That employee wasn't found." } };
const DATES_MISSING = 'Choose a start and end date.';

const endOf = (p: PeriodOption) => addDays(p.start, p.numDays - 1);

export function ReportsClient({ filterOptions, role, periodOptions, today, unpriced }: Props) {
  const isAdmin = role === 'admin';
  const busy = useBusy();
  const [errors, setErrors] = useState<Record<Row, string | null>>({ pdf: null, costs: null, summary: null, periodCost: null, unpriced: null });
  const setError = (row: Row, message: string | null) => setErrors((e) => (e[row] === message ? e : { ...e, [row]: message }));

  // ── Period presets ────────────────────────────────────────────────────────────────────────────────────────────
  const thisPeriod = periodOptions[periodOptions.length - 1];
  const lastPeriod = periodOptions[periodOptions.length - 2];
  const basePresets = [
    ...(lastPeriod ? [{ value: 'lastPeriod', label: `Last pay period · ${periodLabel(lastPeriod.start, endOf(lastPeriod))}` }] : []),
    ...(thisPeriod ? [{ value: 'thisPeriod', label: `This pay period · ${periodLabel(thisPeriod.start, endOf(thisPeriod))}` }] : []),
    { value: 'thisMonth', label: `This month · ${periodLabel(startOfMonth(today), today)}` },
  ];

  // ── Signed timesheet ──────────────────────────────────────────────────────────────────────────────────────────
  const [pdfUserId, setPdfUserId] = useState<string | null>(null);
  const [pdfPeriodStart, setPdfPeriodStart] = useState<CalendarDate | null>(lastPeriod?.start ?? thisPeriod?.start ?? null);
  const pdfPeriodData = [...periodOptions].reverse().map((p, i) => ({
    value: p.start,
    label: i === 0 ? `This pay period · ${periodLabel(p.start, endOf(p))}` : i === 1 ? `Last pay period · ${periodLabel(p.start, endOf(p))}` : periodLabel(p.start, endOf(p)),
  }));

  // ── Contract costs / Hours summary ────────────────────────────────────────────────────────────────────────────
  const [costContractId, setCostContractId] = useState<string | null>(null);
  const [costRange, setCostRange] = useState<PeriodSelection>({ preset: basePresets[0].value, start: null, end: null });
  const [summaryRange, setSummaryRange] = useState<PeriodSelection>({ preset: basePresets[0].value, start: null, end: null });
  const costContract = filterOptions.contracts.find((c) => c.id === costContractId) ?? null;
  const contractToDateLabel = (() => {
    if (!costContract?.startDate) return 'Contract to date';
    const s = isBefore(today, costContract.startDate) ? today : costContract.startDate; // a future start is clamped
    return `Contract to date · ${periodLabel(s, today)}`;
  })();
  const costPresets = costContract ? [...basePresets, { value: 'contractToDate', label: contractToDateLabel }] : basePresets;

  // ── Cost by pay period ────────────────────────────────────────────────────────────────────────────────────────
  const [periodCount, setPeriodCount] = useState('6');

  /** A selection → a concrete range through the server (the one preset resolver), or the message to show. */
  async function resolveRange(sel: PeriodSelection, contractId: string | null): Promise<{ start: CalendarDate; end: CalendarDate } | { error: string }> {
    if (!periodSelectionReady(sel)) return { error: periodSelectionError(sel) ?? DATES_MISSING };
    const preset: PeriodPreset = sel.preset === CUSTOM_PRESET ? { kind: 'custom', start: sel.start!, end: sel.end! }
      : sel.preset === 'contractToDate' && contractId ? { kind: 'contractToDate', contractId }
        : { kind: sel.preset as 'lastPeriod' | 'thisPeriod' | 'thisMonth' };
    const result = await runAction(resolvePeriodRange(preset), { silent: true });
    if (!result.ok) return { error: result.error };
    const { start, end } = result.data;
    return start && end ? { start, end } : { error: DATES_MISSING };
  }

  /** Run one button's download under its busy key; any failure lands in that row's alert. */
  function download(row: Row, key: string, target: () => Promise<{ url: string; name: string; opts?: DownloadOptions } | { error: string }>) {
    void busy.run(key, async () => {
      setError(row, null);
      const t = await target();
      if ('error' in t) { setError(row, t.error); return; }
      const result = await downloadFile(t.url, t.name, t.opts);
      if (!result.ok) setError(row, result.error);
    }, { group: row }); // a row's buttons block each other (UX-4B1-AUDIT M4), never another row's
  }

  function downloadPdf() {
    download('pdf', 'pdf:pdf', async () => {
      if (!pdfUserId) return { error: 'Choose an employee.' };
      if (!pdfPeriodStart) return { error: 'Choose a pay period.' };
      const q = new URLSearchParams({ userId: pdfUserId, periodStart: pdfPeriodStart });
      return { url: `/api/reports/timesheet-pdf?${q}`, name: `timesheet-${pdfPeriodStart}.pdf`, opts: PDF_MESSAGES };
    });
  }

  function downloadCosts(format: 'excel' | 'csv') {
    download('costs', `costs:${format}`, async () => {
      const range = await resolveRange(costRange, costContractId);
      if ('error' in range) return range;
      const q = new URLSearchParams({ startDate: range.start, endDate: range.end });
      if (costContractId) q.set('contractId', costContractId);
      const ext = format === 'excel' ? 'xlsx' : 'csv';
      return { url: `/api/reports/cost-report-${ext}?${q}`, name: `cost-report-${range.start}-to-${range.end}.${ext}` };
    });
  }

  function downloadSummary() {
    download('summary', 'summary:excel', async () => {
      const range = await resolveRange(summaryRange, null);
      if ('error' in range) return range;
      const q = new URLSearchParams({ startDate: range.start, endDate: range.end, format: 'summary' });
      return { url: `/api/reports/cost-report-xlsx?${q}`, name: `hours-summary-${range.start}-to-${range.end}.xlsx` };
    });
  }

  function downloadPeriodCost() {
    download('periodCost', 'periodCost:excel', async () => ({
      url: `/api/reports/period-cost-xlsx?n=${periodCount}`, name: `cost-by-pay-period-last-${periodCount}.xlsx`,
    }));
  }

  function downloadUnpriced() {
    download('unpriced', 'unpriced:excel', async () => ({ url: '/api/reports/unpriced-xlsx', name: 'unpriced-hours.xlsx' }));
  }

  const rowError = (row: Row) => errors[row] && (
    <Text size="sm" className={classes.error} role="alert" data-testid={`report-error-${row}`}>{errors[row]}</Text>
  );

  const report = (row: Row, title: string, description: ReactNode, inputs: ReactNode, buttons: ReactNode) => (
    <div className={classes.report} data-testid={`report-${row}`}>
      <div>
        <h2 className={classes.title}>{title}</h2>
        <div className={classes.description}>{description}</div>
        {rowError(row)}
      </div>
      <Stack gap={8}>{inputs}</Stack>
      <div className={classes.buttons}>{buttons}</div>
    </div>
  );

  const unpricedText = !unpriced || (unpriced.hours === 0 && unpriced.groups === 0)
    ? 'All time · nothing to fix'
    : `All time · ${formatHours(unpriced.hours)} hours · ${formatCount(unpriced.groups)} ${unpriced.groups === 1 ? 'thing' : 'things'} to fix`;

  return (
    <>
      <PageHeader title="Downloads" description="Download timesheets, costs and hours for any pay period or date range." />

      <Paper withBorder radius="md" className={classes.panel}>
        {report('pdf', 'Signed timesheet',
          'An employee’s timesheet for one pay period, with signatures and the audit trail.',
          <>
            <Select
              label="Employee" placeholder="Choose an employee" searchable
              data={filterOptions.users.map((u) => ({ value: u.id, label: `${u.fullName} (${u.email})` }))}
              value={pdfUserId}
              onChange={(v) => { setPdfUserId(v); setError('pdf', null); }}
            />
            <Select
              label="Pay period" searchable allowDeselect={false}
              data={pdfPeriodData}
              value={pdfPeriodStart}
              onChange={(v) => { setPdfPeriodStart(v && isCalendarDate(v) ? v : null); setError('pdf', null); }}
            />
          </>,
          <Button {...busy.props('pdf:pdf', { group: 'pdf' })} onClick={downloadPdf}>Download PDF</Button>,
        )}

        {isAdmin && report('costs', 'Contract costs',
          <>
            Hours and cost by contract, CLIN and labor category, using the rate in effect each day.
            <div className={classes.note}>{CURRENT_RATES_NOTE}</div>
          </>,
          <>
            <Select
              label="Contract" placeholder="All contracts" clearable searchable
              data={filterOptions.contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.contractNumber})` }))}
              value={costContractId}
              onChange={(v) => {
                setCostContractId(v);
                if (!v && costRange.preset === 'contractToDate') setCostRange({ ...costRange, preset: basePresets[0].value });
                setError('costs', null);
              }}
            />
            <PeriodPresetSelect label="Dates" presets={costPresets} value={costRange} onChange={(v) => { setCostRange(v); setError('costs', null); }} />
          </>,
          <>
            <Button variant="default" {...busy.props('costs:excel', { group: 'costs' })} onClick={() => downloadCosts('excel')}>Excel</Button>
            <Button variant="default" {...busy.props('costs:csv', { group: 'costs' })} onClick={() => downloadCosts('csv')}>CSV</Button>
          </>,
        )}

        {report('summary', 'Hours summary',
          'Total hours per employee by contract and CLIN (direct time only).',
          <PeriodPresetSelect label="Dates" presets={basePresets} value={summaryRange} onChange={(v) => { setSummaryRange(v); setError('summary', null); }} />,
          <Button variant="default" {...busy.props('summary:excel', { group: 'summary' })} onClick={downloadSummary}>Excel</Button>,
        )}

        {isAdmin && report('periodCost', 'Cost by pay period',
          'Hours and cost for each pay period and contract.',
          <Select
            label="Pay periods" allowDeselect={false}
            data={PERIOD_COUNTS.map((n) => ({ value: n, label: `Last ${n} pay periods` }))}
            value={periodCount}
            onChange={(v) => { if (v) setPeriodCount(v); setError('periodCost', null); }}
          />,
          <Button variant="default" {...busy.props('periodCost:excel', { group: 'periodCost' })} onClick={downloadPeriodCost}>Excel</Button>,
        )}

        {isAdmin && report('unpriced', 'Unpriced hours',
          'Hours with no labor-category rate or with overlapping assignments.',
          <Text size="sm" c="dimmed" data-testid="unpriced-summary">{unpricedText}</Text>,
          <>
            <Button variant="default" component={Link} href={UNPRICED_REPORT_HREF}>View</Button>
            <Button variant="default" {...busy.props('unpriced:excel', { group: 'unpriced' })} onClick={downloadUnpriced}>Excel</Button>
          </>,
        )}
      </Paper>
    </>
  );
}
