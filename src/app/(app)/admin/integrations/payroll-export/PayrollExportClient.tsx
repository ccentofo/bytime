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
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import {
  getPayrollExportPreview,
  generatePayrollExportCSV,
} from '@/server/actions/payroll-export';
import { daysInMonth, isCalendarDate, startOfMonth, withDayOfMonth, type CalendarDate } from '@/lib/calendar-date';

const FORMAT_OPTIONS = [
  { value: 'adp', label: 'ADP Workforce Now', description: 'Standard ADP payroll import' },
  { value: 'paychex', label: 'Paychex Flex', description: 'Paychex payroll import' },
  { value: 'gusto', label: 'Gusto', description: 'Gusto bulk hours import' },
  { value: 'custom', label: 'Custom Format', description: 'All columns included' },
];

interface PreviewEmployee {
  employeeName: string;
  employeeEmail: string;
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
  billableHours: number;
  nonBillableHours: number;
  periodStart: string;
  periodEnd: string;
}

export function PayrollExportClient({ today }: { today: CalendarDate }) {
  const [format, setFormat] = useState<string | null>('adp');
  // Default range: this month in the workspace's calendar (server-provided today).
  const [dateRange, setDateRange] = useState<[CalendarDate | null, CalendarDate | null]>([
    startOfMonth(today),
    withDayOfMonth(today, daysInMonth(today)),
  ]);
  const [preview, setPreview] = useState<PreviewEmployee[] | null>(null);
  const [totalEntries, setTotalEntries] = useState(0);
  const [isPending, startTransition] = useTransition();
  const [isDownloading, setIsDownloading] = useState(false);

  async function handlePreview() {
    if (!dateRange[0] || !dateRange[1]) {
      notifications.show({ title: 'Date range required', message: 'Select a start and end date.', color: 'warning' });
      return;
    }

    startTransition(async () => {
      try {
        const result = await getPayrollExportPreview({
          periodStart: dateRange[0]!,
          periodEnd: dateRange[1]!,
        });
        setPreview(result.employees);
        setTotalEntries(result.totalEntries);

        if (result.employees.length === 0) {
          notifications.show({ title: 'No approved data', message: 'No approved timesheet entries found for this date range.', color: 'warning' });
        }
      } catch (error) {
        notifications.show({ title: 'Preview failed', message: String(error), color: 'red' });
      }
    });
  }

  async function handleDownload() {
    if (!format || !dateRange[0] || !dateRange[1]) {
      notifications.show({ title: 'Missing fields', message: 'Select a format and date range.', color: 'warning' });
      return;
    }

    setIsDownloading(true);
    try {
      const result = await generatePayrollExportCSV({
        periodStart: dateRange[0],
        periodEnd: dateRange[1],
        format: format as any,
      });

      // Trigger browser download
      const blob = new Blob([result.csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      notifications.show({
        title: 'Export downloaded',
        message: `${result.employeeCount} employees, ${result.totalHours.toFixed(1)} total hours`,
        color: 'success',
      });
    } catch (error) {
      notifications.show({ title: 'Export failed', message: String(error), color: 'red' });
    } finally {
      setIsDownloading(false);
    }
  }

  const totalHours = preview?.reduce((sum, e) => sum + e.totalHours, 0) ?? 0;

  return (
    <Container size="lg" py="xl">
      {/* Header */}
      <Group mb="md">
        <Anchor href="/admin/integrations" size="sm">
          <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
          Back to Integrations
        </Anchor>
      </Group>

      <Group justify="space-between" align="flex-start" mb="xl">
        <div>
          <Group gap="sm" mb={4}>
            <ThemeIcon size="lg" color="warning" variant="light" radius="md">
              <IconFileExport size={20} />
            </ThemeIcon>
            <Title order={2}>Payroll Export</Title>
          </Group>
          <Text c="dimmed" size="sm">
            Download approved timesheet data formatted for your payroll system.
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
              onChange={(value) => setDateRange([
                value[0] && isCalendarDate(value[0]) ? value[0] : null,
                value[1] && isCalendarDate(value[1]) ? value[1] : null,
              ])}
              leftSection={<IconCalendar size={16} />}
            />
          </Group>

          {format && (
            <Alert color="signal" variant="light">
              <Text size="sm">
                <strong>{FORMAT_OPTIONS.find((f) => f.value === format)?.label}</strong>
                {' — '}
                {FORMAT_OPTIONS.find((f) => f.value === format)?.description}
              </Text>
            </Alert>
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
              onClick={handleDownload}
              loading={isDownloading}
              disabled={!format || !dateRange[0] || !dateRange[1]}
            >
              Download CSV
            </Button>
          </Group>
        </Stack>
      </Paper>

      {/* Preview Table */}
      {preview !== null && (
        <>
          {/* Summary Stats */}
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md" mb="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed">Employees</Text>
              <Text fw={700} size="xl">{preview.length}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed">Total Hours</Text>
              <Text fw={700} size="xl">{totalHours.toFixed(1)}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed">Timesheet Entries</Text>
              <Text fw={700} size="xl">{totalEntries}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed">Data Source</Text>
              <Badge color="success" variant="light" size="lg" mt={4}>Approved Only</Badge>
            </Paper>
          </SimpleGrid>

          {/* Employee Table */}
          <Paper withBorder radius="md">
            <Table.ScrollContainer minWidth={600}>

            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Employee</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Regular</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>OT</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Total</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Billable</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Non-Billable</Table.Th>
                  <Table.Th>Period</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={7}>
                      <Text c="dimmed" ta="center" py="md">
                        No approved timesheet data found for this date range.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  preview.map((emp) => (
                    <Table.Tr key={emp.employeeEmail}>
                      <Table.Td>
                        <Text size="sm" fw={500}>{emp.employeeName}</Text>
                        <Text size="xs" c="dimmed">{emp.employeeEmail}</Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        <Text size="sm">{emp.regularHours.toFixed(1)}</Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        <Text size="sm" c={emp.overtimeHours > 0 ? 'warning' : undefined} fw={emp.overtimeHours > 0 ? 600 : undefined}>
                          {emp.overtimeHours.toFixed(1)}
                        </Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        <Text size="sm" fw={600}>{emp.totalHours.toFixed(1)}</Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        <Text size="sm">{emp.billableHours.toFixed(1)}</Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        <Text size="sm">{emp.nonBillableHours.toFixed(1)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">{emp.periodStart} — {emp.periodEnd}</Text>
                      </Table.Td>
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
