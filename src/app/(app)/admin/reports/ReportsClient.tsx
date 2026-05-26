'use client';

import { useState } from 'react';
import {
  Title,
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
import dayjs from 'dayjs';
import { getNumDaysInPeriod, navigatePeriod, getCurrentPeriodStart } from '@/lib/date-utils';

// Generate semi-monthly pay period options (current + last 11 = 12 total, ~6 months)
function generatePeriodOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  let periodStart = getCurrentPeriodStart();

  for (let i = 0; i < 12; i++) {
    const start = dayjs(periodStart);
    const numDays = getNumDaysInPeriod(periodStart);
    const end = start.add(numDays - 1, 'day');
    options.push({
      value: start.format('YYYY-MM-DD'),
      label: `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`,
    });
    periodStart = navigatePeriod(periodStart, 'prev');
  }

  return options;
}

type FilterOptions = {
  users: Array<{ id: string; fullName: string; email: string }>;
  contracts: Array<{ id: string; name: string; contractNumber: string }>;
};

type Props = {
  filterOptions: FilterOptions;
};

export function ReportsClient({ filterOptions }: Props) {
  // Timesheet PDF state
  const [pdfUserId, setPdfUserId] = useState<string | null>(null);
  const [pdfPeriodStart, setPdfPeriodStart] = useState<string>('');

  // Cost Report state
  const [costStartDate, setCostStartDate] = useState<string>('');
  const [costEndDate, setCostEndDate] = useState<string>('');
  const [costContractId, setCostContractId] = useState<string | null>(null);

  // Employee Summary state
  const [summaryStartDate, setSummaryStartDate] = useState<string>('');
  const [summaryEndDate, setSummaryEndDate] = useState<string>('');

  function downloadTimesheetPdf() {
    if (!pdfUserId || !pdfPeriodStart) {
      notifications.show({ title: 'Missing Fields', message: 'Select an employee and period start date.', color: 'yellow' });
      return;
    }
    const params = new URLSearchParams({
      userId: pdfUserId,
      periodStart: dayjs(pdfPeriodStart).format('YYYY-MM-DD'),
    });
    window.open(`/api/reports/timesheet-pdf?${params.toString()}`, '_blank');
  }

  function downloadCostCsv() {
    if (!costStartDate || !costEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'yellow' });
      return;
    }
    const params = new URLSearchParams({
      startDate: dayjs(costStartDate).format('YYYY-MM-DD'),
      endDate: dayjs(costEndDate).format('YYYY-MM-DD'),
    });
    if (costContractId) params.set('contractId', costContractId);
    window.open(`/api/reports/cost-report-csv?${params.toString()}`, '_blank');
  }

  function downloadCostExcel() {
    if (!costStartDate || !costEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'yellow' });
      return;
    }
    const params = new URLSearchParams({
      startDate: dayjs(costStartDate).format('YYYY-MM-DD'),
      endDate: dayjs(costEndDate).format('YYYY-MM-DD'),
    });
    if (costContractId) params.set('contractId', costContractId);
    window.open(`/api/reports/cost-report-xlsx?${params.toString()}`, '_blank');
  }

  function downloadSummaryExcel() {
    if (!summaryStartDate || !summaryEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'yellow' });
      return;
    }
    // Uses the same Excel endpoint but with summary format — we can add a format param
    const params = new URLSearchParams({
      startDate: dayjs(summaryStartDate).format('YYYY-MM-DD'),
      endDate: dayjs(summaryEndDate).format('YYYY-MM-DD'),
      format: 'summary',
    });
    window.open(`/api/reports/cost-report-xlsx?${params.toString()}`, '_blank');
  }

  return (
    <>
      <Title order={2} mb="md">Reports & Export</Title>

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
              data={generatePeriodOptions()}
              value={pdfPeriodStart || null}
              onChange={(val) => setPdfPeriodStart(val ?? '')}
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

        {/* --- Cost Report (CSV/Excel) --- */}
        <Paper withBorder p="lg" radius="md">
          <Group mb="md">
            <ThemeIcon color="green" variant="light" size="lg" radius="md">
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
                value={costStartDate ? new Date(costStartDate + 'T00:00:00') : null}
                onChange={(date) => setCostStartDate(date ? dayjs(date).format('YYYY-MM-DD') : '')}
                clearable
              />
              <DateInput
                label="End Date"
                placeholder="Select end date"
                value={costEndDate ? new Date(costEndDate + 'T00:00:00') : null}
                onChange={(date) => setCostEndDate(date ? dayjs(date).format('YYYY-MM-DD') : '')}
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
                color="green"
              >
                Download Excel
              </Button>
            </Group>
          </Stack>
        </Paper>

        {/* --- Employee Summary --- */}
        <Paper withBorder p="lg" radius="md">
          <Group mb="md">
            <ThemeIcon color="blue" variant="light" size="lg" radius="md">
              <IconFileSpreadsheet size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600}>Employee Summary Report</Text>
              <Text size="xs" c="dimmed">Aggregated hours & cost by employee per contract/CLIN</Text>
            </div>
          </Group>

          <Stack gap="sm">
            <Group grow>
              <DateInput
                label="Start Date"
                placeholder="Select start date"
                value={summaryStartDate ? new Date(summaryStartDate + 'T00:00:00') : null}
                onChange={(date) => setSummaryStartDate(date ? dayjs(date).format('YYYY-MM-DD') : '')}
                clearable
              />
              <DateInput
                label="End Date"
                placeholder="Select end date"
                value={summaryEndDate ? new Date(summaryEndDate + 'T00:00:00') : null}
                onChange={(date) => setSummaryEndDate(date ? dayjs(date).format('YYYY-MM-DD') : '')}
                clearable
              />
            </Group>
            <Button
              leftSection={<IconFileSpreadsheet size={16} />}
              onClick={downloadSummaryExcel}
              disabled={!summaryStartDate || !summaryEndDate}
              color="blue"
            >
              Download Summary Excel
            </Button>
          </Stack>
        </Paper>
      </SimpleGrid>
    </>
  );
}
