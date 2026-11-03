'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Paper,
  Stack,
  Group,
  Button,
  Select,
  Divider,
  Text,
  SimpleGrid,
  ThemeIcon,
  Alert,
  Loader,
} from '@mantine/core';
import {
  IconFileTypePdf,
  IconFileTypeCsv,
  IconFileSpreadsheet,
  IconDownload,
  IconReportAnalytics,
} from '@tabler/icons-react';
import { DateInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { getPeriodOptions, getWorkspaceContext, type PeriodOption } from '@/server/actions/periods';
import { PageHeader } from '@/components/ui/PageHeader';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';
import { downloadFile } from '@/lib/download';
import { toastError } from '@/lib/toast';

/** A report card (feature-plan-ux-page-fixes.md C15): each has its own busy state and its own inline error. */
type Card = 'pdf' | 'cost' | 'summary';

type FilterOptions = {
  users: Array<{ id: string; fullName: string; email: string }>;
  contracts: Array<{ id: string; name: string; contractNumber: string }>;
};

type Props = {
  filterOptions: FilterOptions;
  role: 'admin' | 'supervisor' | 'employee';
};

export function ReportsClient({ filterOptions, role }: Props) {
  const isAdmin = role === 'admin';
  // Timesheet PDF state
  const [pdfUserId, setPdfUserId] = useState<string | null>(null);
  const [pdfPeriodStart, setPdfPeriodStart] = useState<CalendarDate | null>(null);
  const [periodOptions, setPeriodOptions] = useState<PeriodOption[]>([]);

  // Cost Report state
  const [costStartDate, setCostStartDate] = useState<CalendarDate | null>(null);
  const [costEndDate, setCostEndDate] = useState<CalendarDate | null>(null);
  const [costContractId, setCostContractId] = useState<string | null>(null);

  // Employee Summary state
  const [summaryStartDate, setSummaryStartDate] = useState<CalendarDate | null>(null);
  const [summaryEndDate, setSummaryEndDate] = useState<CalendarDate | null>(null);

  // C15: downloads go through fetch (downloadFile), never window.open. Per card: which button is busy (the card's
  // buttons are aria-disabled meanwhile, never `disabled`) and its error, cleared on the next attempt or an input change.
  const [busy, setBusy] = useState<Record<Card, string | null>>({ pdf: null, cost: null, summary: null });
  const [errors, setErrors] = useState<Record<Card, string | null>>({ pdf: null, cost: null, summary: null });
  // Written only in handlers and the effect: a second click before the re-render is ignored; no setState after unmount.
  const inFlight = useRef<Record<Card, boolean>>({ pdf: false, cost: false, summary: false });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const clearError = (card: Card) => setErrors((e) => (e[card] ? { ...e, [card]: null } : e));

  async function runDownload(card: Card, button: string, url: string, fallbackName: string) {
    if (inFlight.current[card]) return;
    inFlight.current[card] = true;
    setBusy((b) => ({ ...b, [card]: button }));
    clearError(card);
    try {
      const result = await downloadFile(url, fallbackName);
      if (mounted.current && !result.ok) setErrors((e) => ({ ...e, [card]: result.error }));
    } finally {
      inFlight.current[card] = false;
      if (mounted.current) setBusy((b) => ({ ...b, [card]: null }));
    }
  }

  /** The download button's props for one card: aria-disabled + a Loader while that card is busy. */
  const busyProps = (card: Card, button: string, icon: ReactNode) => ({
    'aria-disabled': busy[card] ? true : undefined,
    'data-disabled': busy[card] ? true : undefined,
    leftSection: busy[card] === button ? <Loader size={16} aria-hidden="true" /> : icon,
  });
  const cardError = (card: Card) => errors[card] && (
    <Alert color="red" role="alert" variant="light" data-testid={`report-error-${card}`}>{errors[card]}</Alert>
  );

  // D4: the client does no schedule math of its own — the pay-period dropdown comes from the
  // server (getPeriodOptions), so it stays correct across a pay-schedule change instead of
  // assuming semimonthly for every tenant.
  useEffect(() => {
    getWorkspaceContext()
      .then(({ today }) => getPeriodOptions(today, 11, 0))
      .then((options) => setPeriodOptions([...options].reverse()))
      .catch((error) => {
        console.error('Failed to load pay periods:', error);
        toastError({ title: 'Could not load pay periods', message: 'Reload the page to try again.' });
      });
  }, []);

  function downloadTimesheetPdf() {
    if (!pdfUserId || !pdfPeriodStart) {
      notifications.show({ title: 'Missing Fields', message: 'Select an employee and period start date.', color: 'warning' });
      return;
    }
    const params = new URLSearchParams({
      userId: pdfUserId,
      periodStart: pdfPeriodStart,
    });
    void runDownload('pdf', 'pdf', `/api/reports/timesheet-pdf?${params.toString()}`, `timesheet-${pdfPeriodStart}.pdf`);
  }

  function downloadCostCsv() {
    if (!costStartDate || !costEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'warning' });
      return;
    }
    const params = new URLSearchParams({
      startDate: costStartDate,
      endDate: costEndDate,
    });
    if (costContractId) params.set('contractId', costContractId);
    void runDownload('cost', 'csv', `/api/reports/cost-report-csv?${params.toString()}`, `cost-report-${costStartDate}-to-${costEndDate}.csv`);
  }

  function downloadCostExcel() {
    if (!costStartDate || !costEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'warning' });
      return;
    }
    const params = new URLSearchParams({
      startDate: costStartDate,
      endDate: costEndDate,
    });
    if (costContractId) params.set('contractId', costContractId);
    void runDownload('cost', 'xlsx', `/api/reports/cost-report-xlsx?${params.toString()}`, `cost-report-${costStartDate}-to-${costEndDate}.xlsx`);
  }

  function downloadSummaryExcel() {
    if (!summaryStartDate || !summaryEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'warning' });
      return;
    }
    // Uses the same Excel endpoint but with summary format — we can add a format param
    const params = new URLSearchParams({
      startDate: summaryStartDate,
      endDate: summaryEndDate,
      format: 'summary',
    });
    void runDownload('summary', 'xlsx', `/api/reports/cost-report-xlsx?${params.toString()}`, `employee-summary-${summaryStartDate}-to-${summaryEndDate}.xlsx`);
  }

  return (
    <>
      <PageHeader title="Reports & Export" />

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xl">
        {/* --- Individual Timesheet PDF --- */}
        <Paper withBorder p="lg" radius="md">
          <Group mb="md">
            <ThemeIcon color="red" variant="light" size="lg" radius="md">
              <IconFileTypePdf size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600}>Individual Timesheet (PDF)</Text>
              <Text size="xs" c="dimmed">DCAA-compliant timesheet with certification statement</Text>
            </div>
          </Group>

          <Stack gap="sm">
            <Select
              label="Employee"
              placeholder="Select employee"
              data={filterOptions.users.map((u) => ({ value: u.id, label: `${u.fullName} (${u.email})` }))}
              value={pdfUserId}
              onChange={(v) => { setPdfUserId(v); clearError('pdf'); }}
              searchable
            />
            <Select
              label="Pay Period"
              placeholder="Select pay period"
              data={periodOptions.map((o) => ({ value: o.start, label: o.label }))}
              value={pdfPeriodStart}
              onChange={(val) => { setPdfPeriodStart(val && isCalendarDate(val) ? val : null); clearError('pdf'); }}
              searchable
            />
            <Button
              {...busyProps('pdf', 'pdf', <IconDownload size={16} />)}
              onClick={downloadTimesheetPdf}
              disabled={!pdfUserId || !pdfPeriodStart}
              color="red"
            >
              Download PDF
            </Button>
            {cardError('pdf')}
          </Stack>
        </Paper>

        {/* --- Detailed Cost Report (CSV/Excel) — admin-only: dollar data --- */}
        {isAdmin && (
          <Paper withBorder p="lg" radius="md">
            <Group mb="md">
              <ThemeIcon color="success" variant="light" size="lg" radius="md">
                <IconReportAnalytics size={20} />
              </ThemeIcon>
              <div>
                <Text fw={600}>Detailed Cost Report</Text>
                <Text size="xs" c="dimmed">Hours × rates by employee, CLIN, and LCAT</Text>
                {/* certified-outputs C3: CO-D7 interim note; unpriced hours are counted in the file's footer (CO-D17). */}
                <Text size="xs" c="dimmed">{CURRENT_RATES_NOTE} Hours with no applicable labor category are listed as unpriced (no cost) and totalled in the file.</Text>
              </div>
            </Group>

            <Stack gap="sm">
              <Group grow>
                <DateInput
                  label="Start Date"
                  placeholder="Select start date"
                  value={costStartDate}
                  onChange={(date) => { setCostStartDate(date && isCalendarDate(date) ? date : null); clearError('cost'); }}
                  clearable
                />
                <DateInput
                  label="End Date"
                  placeholder="Select end date"
                  value={costEndDate}
                  onChange={(date) => { setCostEndDate(date && isCalendarDate(date) ? date : null); clearError('cost'); }}
                  clearable
                />
              </Group>
              <Select
                label="Contract (optional)"
                placeholder="All contracts"
                data={filterOptions.contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.contractNumber})` }))}
                value={costContractId}
                onChange={(v) => { setCostContractId(v); clearError('cost'); }}
                clearable
                searchable
              />
              <Group>
                <Button
                  {...busyProps('cost', 'csv', <IconFileTypeCsv size={16} />)}
                  onClick={downloadCostCsv}
                  disabled={!costStartDate || !costEndDate}
                  variant="default"
                >
                  Download CSV
                </Button>
                <Button
                  {...busyProps('cost', 'xlsx', <IconFileSpreadsheet size={16} />)}
                  onClick={downloadCostExcel}
                  disabled={!costStartDate || !costEndDate}
                  color="success"
                >
                  Download Excel
                </Button>
              </Group>
              {cardError('cost')}
            </Stack>
          </Paper>
        )}

        {/* --- Employee Summary --- */}
        <Paper withBorder p="lg" radius="md">
          <Group mb="md">
            <ThemeIcon color="signal" variant="light" size="lg" radius="md">
              <IconFileSpreadsheet size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600}>Employee Summary Report</Text>
              <Text size="xs" c="dimmed">
                {isAdmin ? 'Aggregated hours & cost by employee per contract/CLIN' : 'Aggregated hours by employee per contract/CLIN'}
              </Text>
              {isAdmin && <Text size="xs" c="dimmed">{CURRENT_RATES_NOTE}</Text>}
            </div>
          </Group>

          <Stack gap="sm">
            <Group grow>
              <DateInput
                label="Start Date"
                placeholder="Select start date"
                value={summaryStartDate}
                onChange={(date) => { setSummaryStartDate(date && isCalendarDate(date) ? date : null); clearError('summary'); }}
                clearable
              />
              <DateInput
                label="End Date"
                placeholder="Select end date"
                value={summaryEndDate}
                onChange={(date) => { setSummaryEndDate(date && isCalendarDate(date) ? date : null); clearError('summary'); }}
                clearable
              />
            </Group>
            <Button
              {...busyProps('summary', 'xlsx', <IconFileSpreadsheet size={16} />)}
              onClick={downloadSummaryExcel}
              disabled={!summaryStartDate || !summaryEndDate}
              color="signal"
            >
              Download Summary Excel
            </Button>
            {cardError('summary')}
          </Stack>
        </Paper>
      </SimpleGrid>
    </>
  );
}
