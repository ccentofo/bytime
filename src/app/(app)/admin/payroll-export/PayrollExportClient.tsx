'use client';

import { useState, useTransition } from 'react';
import {
  Container,
  Title,
  Text,
  Paper,
  Group,
  Badge,
  Button,
  Stack,
  Select,
  Table,
  Alert,
  ThemeIcon,
  Anchor,
  SimpleGrid,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconFileExport,
  IconDownload,
  IconArrowLeft,
  IconEye,
  IconCalendar,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import {
  getPayrollExportPreview,
  generatePayrollExportCSV,
  type PayrollPreview,
  type PayrollPreviewEmployee,
} from '@/server/actions/payroll-export';
import { runAction } from '@/lib/run-action';
import { daysInMonth, isCalendarDate, startOfMonth, withDayOfMonth, type CalendarDate } from '@/lib/calendar-date';

const FORMAT_OPTIONS = [
  { value: 'adp', label: 'ADP Workforce Now', description: 'Standard ADP payroll import' },
  { value: 'paychex', label: 'Paychex Flex', description: 'Paychex payroll import' },
  { value: 'gusto', label: 'Gusto', description: 'Gusto bulk hours import' },
  { value: 'custom', label: 'Custom Format', description: 'All columns included' },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const h = (n: number) => n.toFixed(2);

export function PayrollExportClient({ today }: { today: CalendarDate }) {
  const [format, setFormat] = useState<string | null>('adp');
  // Default range: this month in the workspace's calendar (server-provided today).
  const [dateRange, setDateRange] = useState<[CalendarDate | null, CalendarDate | null]>([
    startOfMonth(today),
    withDayOfMonth(today, daysInMonth(today)),
  ]);
  // Fix round 1 (F4): a preview belongs to the range it was generated for. Downloads need a READY preview of the
  // CURRENT range, so the flagged employees are always seen before a file is downloaded.
  const [previewState, setPreviewState] = useState<{ range: string; data: PayrollPreview } | null>(null);
  const rangeKey = `${dateRange[0] ?? ''}|${dateRange[1] ?? ''}`;
  const preview = previewState && previewState.range === rangeKey ? previewState.data : null;
  const canDownload = preview?.status === 'ready';
  const [isPending, startTransition] = useTransition();
  const [isDownloading, setIsDownloading] = useState(false);

  async function handlePreview() {
    if (!dateRange[0] || !dateRange[1]) {
      notifications.show({ title: 'Date range required', message: 'Select a start and end date.', color: 'warning' });
      return;
    }

    startTransition(async () => {
      const requested = rangeKey;
      const result = await runAction(getPayrollExportPreview({ periodStart: dateRange[0]!, periodEnd: dateRange[1]! }), { errorTitle: 'Preview failed' });
      if (!result.ok) return;
      setPreviewState({ range: requested, data: result.data }); // ignored at render if the range changed meanwhile
      if (result.data.status === 'ready' && result.data.employees.length === 0) {
        notifications.show({ title: 'No approved data', message: 'No approved timesheet entries found for this date range.', color: 'warning' });
      }
    });
  }

  async function download(kind: string) {
    if (!dateRange[0] || !dateRange[1]) {
      notifications.show({ title: 'Missing fields', message: 'Select a format and date range.', color: 'warning' });
      return;
    }

    setIsDownloading(true);
    try {
      const result = await runAction(generatePayrollExportCSV({
        periodStart: dateRange[0],
        periodEnd: dateRange[1],
        format: kind as 'adp' | 'paychex' | 'gusto' | 'custom' | 'daily-hours',
      }), { errorTitle: 'Export failed' });
      if (!result.ok) return;

      // Trigger browser download
      const blob = new Blob([result.data.csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.data.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      notifications.show({
        title: 'Export downloaded',
        message: `${result.data.employeeCount} employees, ${result.data.totalPaidHours.toFixed(2)} paid hours (FLSA weekly overtime)`
          + (result.data.flaggedCount > 0 ? ` — ${result.data.flaggedCount} flagged` : ''),
        color: 'success',
      });
    } finally {
      setIsDownloading(false);
    }
  }

  const employees: PayrollPreviewEmployee[] = preview?.status === 'ready' ? preview.employees : [];
  const flagged = employees.filter((e) => e.otBasisIncludesUnapprovedDays);
  const totalPaid = employees.reduce((sum, e) => sum + e.totalPaidHours, 0);

  return (
    <Container size="lg" py="xl">
      {/* Header */}
      <Group mb="md">
        <Anchor href="/admin/reports" size="sm">
          <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
          Back to reports
        </Anchor>
      </Group>

      <Group justify="space-between" align="flex-start" mb="xl">
        <div>
          <Group gap="sm" mb={4}>
            <ThemeIcon size="lg" color="warning" variant="light" radius="md">
              <IconFileExport size={20} />
            </ThemeIcon>
            <Title order={1} size="h2">Payroll Export</Title>
          </Group>
          <Text c="dimmed" size="sm">
            Download approved timesheet data formatted for your payroll system — FLSA weekly overtime.
          </Text>
        </div>
      </Group>

      {/* Configuration */}
      <Paper withBorder p="lg" radius="md" mb="xl">
        <Stack gap="md">
          <Group grow align="flex-end">
            <Select
              label="Payroll Format"
              placeholder="Select format..."
              data={FORMAT_OPTIONS.map((f) => ({ value: f.value, label: f.label }))}
              value={format}
              onChange={setFormat}
              allowDeselect={false}
            />
            <DatePickerInput
              type="range"
              label="Date Range"
              placeholder="Select period..."
              value={dateRange}
              onChange={(value) => {
                setDateRange([
                  value[0] && isCalendarDate(value[0]) ? value[0] : null,
                  value[1] && isCalendarDate(value[1]) ? value[1] : null,
                ]);
                setPreviewState(null); // a new range needs a new preview
              }}
              leftSection={<IconCalendar size={16} />}
            />
          </Group>

          <Alert color="gray" variant="light" title="FLSA weekly overtime">
            <Text size="sm">
              Overtime is hours worked over 40 in a workweek (federal FLSA; no state rules), computed per workweek
              from your workweek start day — a week that crosses pay periods is one week. Leave never counts toward
              the 40 and is exported in its own columns; unpaid leave is never in a paid column. Exempt employees
              show 0 overtime; their hours over 40 appear as uncompensated overtime in the Custom export and the
              Daily hours detail.
            </Text>
            <Text size="sm" mt={6}>
              Deducting partial days of unpaid leave from an exempt employee&apos;s salary can put the exemption at
              risk under federal rules — that is your payroll accountant&apos;s call.
            </Text>
          </Alert>

          {format && (
            <Alert color="signal" variant="light">
              <Text size="sm">
                <strong>{FORMAT_OPTIONS.find((f) => f.value === format)?.label}</strong>
                {' — '}
                {FORMAT_OPTIONS.find((f) => f.value === format)?.description}
              </Text>
            </Alert>
          )}

          {flagged.length > 0 && (
            <Alert color="warning" variant="light" icon={<IconAlertTriangle size={16} />} title="Overtime uses unapproved days" data-testid="payroll-flagged">
              <Text size="sm">
                These employees&apos; overtime counts hours from unapproved days earlier in the same workweek. Their
                figures may change once those timesheets are approved:
              </Text>
              <Text size="sm" fw={600} mt={4}>{flagged.map((e) => e.employeeName).join(', ')}</Text>
            </Alert>
          )}
          {!canDownload && (
            <Text size="xs" c="dimmed" data-testid="payroll-preview-first">Preview the data for this date range to enable downloads.</Text>
          )}

          <Group>
            <Button
              variant="light"
              leftSection={<IconEye size={16} />}
              onClick={handlePreview}
              loading={isPending}
              disabled={!dateRange[0] || !dateRange[1]}
            >
              Preview Data
            </Button>
            <Button
              variant="filled"
              leftSection={<IconDownload size={16} />}
              onClick={() => format && download(format)}
              loading={isDownloading}
              disabled={!format || !canDownload}
              data-testid="payroll-download"
            >
              Download CSV
            </Button>
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              onClick={() => download('daily-hours')}
              loading={isDownloading}
              disabled={!canDownload}
              data-testid="payroll-download-daily"
            >
              Daily hours detail
            </Button>
          </Group>
        </Stack>
      </Paper>

      {/* Refusal: the export can't run until these are fixed */}
      {preview?.status === 'refused' && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title="Payroll export unavailable" mb="xl" data-testid="payroll-refused">
          <Text size="sm">{preview.message}</Text>
          {preview.reason === 'workweek-unset'
            ? <Anchor href="/settings/workspace" size="sm">Set the workweek start day in Settings</Anchor>
            : <Anchor href="/admin/indirect-codes" size="sm">Set pay types in Indirect Codes</Anchor>}
        </Alert>
      )}

      {/* Preview Table */}
      {preview?.status === 'ready' && (
        <>
          {/* Summary Stats */}
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md" mb="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed">Employees</Text>
              <Text fw={700} size="xl">{employees.length}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed">Total Paid Hours</Text>
              <Text fw={700} size="xl">{totalPaid.toFixed(2)}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed">Workweek starts</Text>
              <Text fw={700} size="xl">{DAY_NAMES[preview.workweekStartDay]}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed">Data Source</Text>
              <Badge color="success" variant="light" size="lg" mt={4}>Approved Only</Badge>
            </Paper>
          </SimpleGrid>

          {/* Employee Table */}
          <Paper withBorder radius="md">
            <Table.ScrollContainer minWidth={900}>

            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Employee</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Regular</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>OT (FLSA weekly)</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Uncomp. OT</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>PTO</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Sick</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Holiday</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Unpaid</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Total paid</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {employees.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={9}>
                      <Text c="dimmed" ta="center" py="md">
                        No approved timesheet data found for this date range.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  employees.map((emp) => (
                    <Table.Tr key={emp.employeeEmail}>
                      <Table.Td>
                        <Group gap={6}>
                          <Text size="sm" fw={500}>{emp.employeeName}</Text>
                          {emp.flsaExempt && <Badge size="xs" variant="light" color="gray">Exempt</Badge>}
                          {emp.otBasisIncludesUnapprovedDays && <Badge size="xs" variant="light" color="warning">Flagged</Badge>}
                        </Group>
                        <Text size="xs" c="dimmed">{emp.employeeEmail}</Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}><Text size="sm">{h(emp.regularHours)}</Text></Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        <Text size="sm" c={emp.overtimeHours > 0 ? 'warning' : undefined} fw={emp.overtimeHours > 0 ? 600 : undefined}>
                          {h(emp.overtimeHours)}
                        </Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}><Text size="sm">{h(emp.uncompensatedOvertimeHours)}</Text></Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}><Text size="sm">{h(emp.ptoHours)}</Text></Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}><Text size="sm">{h(emp.sickHours)}</Text></Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}><Text size="sm">{h(emp.holidayHours)}</Text></Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}><Text size="sm">{h(emp.unpaidLeaveHours)}</Text></Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}><Text size="sm" fw={600}>{h(emp.totalPaidHours)}</Text></Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
            </Table.ScrollContainer>
          </Paper>
        </>
      )}
    </Container>
  );
}
