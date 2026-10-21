'use client';

import { useEffect, useState } from 'react';
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

  // D4: the client does no schedule math of its own — the pay-period dropdown comes from the
  // server (getPeriodOptions), so it stays correct across a pay-schedule change instead of
  // assuming semimonthly for every tenant.
  useEffect(() => {
    getWorkspaceContext().then(({ today }) => {
      getPeriodOptions(today, 11, 0).then((options) => setPeriodOptions([...options].reverse()));
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
    window.open(`/api/reports/timesheet-pdf?${params.toString()}`, '_blank');
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
    window.open(`/api/reports/cost-report-csv?${params.toString()}`, '_blank');
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
    window.open(`/api/reports/cost-report-xlsx?${params.toString()}`, '_blank');
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
    window.open(`/api/reports/cost-report-xlsx?${params.toString()}`, '_blank');
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
              onChange={setPdfUserId}
              searchable
            />
            <Select
              label="Pay Period"
              placeholder="Select pay period"
              data={periodOptions.map((o) => ({ value: o.start, label: o.label }))}
              value={pdfPeriodStart}
              onChange={(val) => setPdfPeriodStart(val && isCalendarDate(val) ? val : null)}
              searchable
            />
            <Button
              leftSection={<IconDownload size={16} />}
              onClick={downloadTimesheetPdf}
              disabled={!pdfUserId || !pdfPeriodStart}
              color="red"
            >
              Download PDF
            </Button>
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
              </div>
            </Group>

            <Stack gap="sm">
              <Group grow>
                <DateInput
                  label="Start Date"
                  placeholder="Select start date"
                  value={costStartDate}
                  onChange={(date) => setCostStartDate(date && isCalendarDate(date) ? date : null)}
                  clearable
                />
                <DateInput
                  label="End Date"
                  placeholder="Select end date"
                  value={costEndDate}
                  onChange={(date) => setCostEndDate(date && isCalendarDate(date) ? date : null)}
                  clearable
                />
              </Group>
              <Select
                label="Contract (optional)"
                placeholder="All contracts"
                data={filterOptions.contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.contractNumber})` }))}
                value={costContractId}
                onChange={setCostContractId}
                clearable
                searchable
              />
              <Group>
                <Button
                  leftSection={<IconFileTypeCsv size={16} />}
                  onClick={downloadCostCsv}
                  disabled={!costStartDate || !costEndDate}
                  variant="default"
                >
                  Download CSV
                </Button>
                <Button
                  leftSection={<IconFileSpreadsheet size={16} />}
                  onClick={downloadCostExcel}
                  disabled={!costStartDate || !costEndDate}
                  color="success"
                >
                  Download Excel
                </Button>
              </Group>
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
            </div>
          </Group>

          <Stack gap="sm">
            <Group grow>
              <DateInput
                label="Start Date"
                placeholder="Select start date"
                value={summaryStartDate}
                onChange={(date) => setSummaryStartDate(date && isCalendarDate(date) ? date : null)}
                clearable
              />
              <DateInput
                label="End Date"
                placeholder="Select end date"
                value={summaryEndDate}
                onChange={(date) => setSummaryEndDate(date && isCalendarDate(date) ? date : null)}
                clearable
              />
            </Group>
            <Button
              leftSection={<IconFileSpreadsheet size={16} />}
              onClick={downloadSummaryExcel}
              disabled={!summaryStartDate || !summaryEndDate}
              color="signal"
            >
              Download Summary Excel
            </Button>
          </Stack>
        </Paper>
      </SimpleGrid>
    </>
  );
}
