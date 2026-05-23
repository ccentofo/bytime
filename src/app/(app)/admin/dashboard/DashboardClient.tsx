'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Paper,
  SimpleGrid,
  ThemeIcon,
  Progress,
  Divider,
  Table,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import {
  IconReportMoney,
  IconCash,
  IconReceipt,
  IconChartBar,
} from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import dayjs from 'dayjs';
import {
  getPeriodCostReport,
  type ContractSummary,
  type PeriodCostEntry,
} from '@/server/actions/dashboard';
import classes from './Dashboard.module.css';

type Props = {
  initialSummaries: ContractSummary[];
};

function formatCurrency(val: number): string {
  return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCurrencyString(val: string | null): string {
  if (!val) return '—';
  const num = parseFloat(val);
  return isNaN(num) ? '—' : formatCurrency(num);
}

function getBurnColor(pct: number): string {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'yellow';
  return 'green';
}

export function DashboardClient({ initialSummaries }: Props) {
  const [isPending, startTransition] = useTransition();
  const [summaries] = useState<ContractSummary[]>(initialSummaries);

  // Period cost report state
  const [reportStartDate, setReportStartDate] = useState<string | null>(null);
  const [reportEndDate, setReportEndDate] = useState<string | null>(null);
  const [costReport, setCostReport] = useState<PeriodCostEntry[]>([]);
  const [hasGeneratedReport, setHasGeneratedReport] = useState(false);

  // Overview calculations
  const totalContracts = summaries.length;
  const totalFunded = summaries.reduce((sum, s) => sum + (parseFloat(s.fundedValue ?? '0') || 0), 0);
  const totalSpent = summaries.reduce((sum, s) => sum + s.totalCost, 0);
  const totalRemaining = totalFunded - totalSpent;

  function handleGenerateReport() {
    if (!reportStartDate || !reportEndDate) return;
    startTransition(async () => {
      const report = await getPeriodCostReport(
        new Date(reportStartDate),
        new Date(reportEndDate),
      );
      setCostReport(report);
      setHasGeneratedReport(true);
    });
  }

  // --- Contract Summary columns ---

  const contractColumns: MRT_ColumnDef<ContractSummary>[] = [
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 240,
    },
    {
      accessorKey: 'contractType',
      header: 'Type',
      Cell: ({ cell }) => (
        <Badge color={cell.getValue<string>() === 'prime' ? 'blue' : 'grape'} variant="light" size="sm">
          {cell.getValue<string>() === 'prime' ? 'Prime' : 'Sub'}
        </Badge>
      ),
      size: 90,
    },
    {
      accessorKey: 'fundedValue',
      header: 'Funded',
      Cell: ({ cell }) => formatCurrencyString(cell.getValue<string | null>()),
      size: 130,
    },
    {
      accessorKey: 'ceilingValue',
      header: 'Ceiling',
      Cell: ({ cell }) => formatCurrencyString(cell.getValue<string | null>()),
      size: 130,
    },
    {
      accessorKey: 'totalHours',
      header: 'Hours Burned',
      Cell: ({ cell }) => cell.getValue<number>().toFixed(2),
      size: 110,
    },
    {
      accessorKey: 'totalCost',
      header: 'Cost Incurred',
      Cell: ({ cell }) => formatCurrency(cell.getValue<number>()),
      size: 130,
    },
    {
      id: 'remaining',
      header: 'Remaining',
      accessorFn: (row) => {
        const funded = parseFloat(row.fundedValue ?? '0') || 0;
        return funded - row.totalCost;
      },
      Cell: ({ cell }) => {
        const remaining = cell.getValue<number>();
        const color = remaining < 0 ? 'red' : remaining < 10000 ? 'orange' : 'green';
        return <Text size="sm" c={color} fw={600}>{formatCurrency(remaining)}</Text>;
      },
      size: 130,
    },
    {
      id: 'burnPct',
      header: 'Burn %',
      accessorFn: (row) => {
        const funded = parseFloat(row.fundedValue ?? '0') || 0;
        if (funded === 0) return 0;
        return Math.round((row.totalCost / funded) * 100);
      },
      Cell: ({ cell }) => {
        const pct = cell.getValue<number>();
        return (
          <Group gap="xs" wrap="nowrap">
            <Progress value={Math.min(pct, 100)} color={getBurnColor(pct)} size="lg" style={{ flex: 1, minWidth: 60 }} />
            <Text size="xs" fw={600} style={{ minWidth: 35 }}>{pct}%</Text>
          </Group>
        );
      },
      size: 150,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      Cell: ({ cell }) => {
        const status = cell.getValue<string>();
        const colors: Record<string, string> = { active: 'green', inactive: 'gray', closed: 'red' };
        return <Badge color={colors[status] ?? 'gray'} variant="light" size="sm">{status}</Badge>;
      },
      size: 100,
    },
  ];

  const contractTable = useMantineReactTable({
    columns: contractColumns,
    data: summaries,
    enableExpanding: true,
    renderDetailPanel: ({ row }) => {
      const contract = row.original;
      if (contract.clinSummaries.length === 0) {
        return <Text size="sm" c="dimmed" p="md">No CLINs for this contract.</Text>;
      }
      return (
        <Stack gap="xs" style={{ margin: '8px 16px' }}>
          <Table striped highlightOnHover withColumnBorders={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>CLIN</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>Funded</Table.Th>
                <Table.Th>Hours</Table.Th>
                <Table.Th>Cost</Table.Th>
                <Table.Th>Remaining</Table.Th>
                <Table.Th>Status</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {contract.clinSummaries.map((clin) => {
                const funded = parseFloat(clin.fundedAmount ?? '0') || 0;
                const remaining = funded - clin.totalCost;
                return (
                  <>
                    <Table.Tr key={clin.clinId}>
                      <Table.Td>{clin.clinNumber}</Table.Td>
                      <Table.Td>{clin.description ?? '—'}</Table.Td>
                      <Table.Td>{formatCurrencyString(clin.fundedAmount)}</Table.Td>
                      <Table.Td>{clin.totalHours.toFixed(2)}</Table.Td>
                      <Table.Td>{formatCurrency(clin.totalCost)}</Table.Td>
                      <Table.Td>
                        <Text size="sm" c={remaining < 0 ? 'red' : 'green'} fw={600}>
                          {clin.fundedAmount ? formatCurrency(remaining) : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={clin.status === 'active' ? 'green' : 'gray'} variant="light" size="sm">
                          {clin.status}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                    {clin.slinSummaries.length > 0 && clin.slinSummaries.map((slin) => {
                      const slinFunded = parseFloat(slin.fundedAmount ?? '0') || 0;
                      const slinRemaining = slinFunded - slin.totalCost;
                      return (
                        <Table.Tr key={slin.slinId} style={{ backgroundColor: 'var(--mantine-color-default-hover)' }}>
                          <Table.Td style={{ paddingLeft: 32 }}>
                            <Text size="xs" c="dimmed">↳ {slin.slinNumber}</Text>
                          </Table.Td>
                          <Table.Td><Text size="xs" c="dimmed">{slin.description ?? '—'}</Text></Table.Td>
                          <Table.Td><Text size="xs">{formatCurrencyString(slin.fundedAmount)}</Text></Table.Td>
                          <Table.Td><Text size="xs">{slin.totalHours.toFixed(2)}</Text></Table.Td>
                          <Table.Td><Text size="xs">{formatCurrency(slin.totalCost)}</Text></Table.Td>
                          <Table.Td>
                            <Text size="xs" c={slinRemaining < 0 ? 'red' : 'green'} fw={600}>
                              {slin.fundedAmount ? formatCurrency(slinRemaining) : '—'}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge size="xs" color={slin.status === 'active' ? 'green' : 'gray'} variant="light">
                              {slin.status}
                            </Badge>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </>
                );
              })}
            </Table.Tbody>
          </Table>
        </Stack>
      );
    },
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      className: classes.tableHeaderCell,
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
  });

  // --- Period Cost Report columns ---

  const costColumns: MRT_ColumnDef<PeriodCostEntry>[] = [
    { accessorKey: 'userName', header: 'Employee', size: 160 },
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 200,
    },
    { accessorKey: 'clinNumber', header: 'CLIN', size: 100 },
    {
      accessorKey: 'slinNumber',
      header: 'SLIN',
      size: 100,
      Cell: ({ cell }) => cell.getValue<string | null>() ?? '—',
    },
    {
      id: 'lcat',
      header: 'LCAT',
      accessorFn: (row) => `${row.lcatCode} — ${row.lcatTitle}`,
      size: 200,
    },
    {
      accessorKey: 'hourlyRate',
      header: 'Rate',
      Cell: ({ cell }) => formatCurrencyString(cell.getValue<string>()) + '/hr',
      size: 120,
    },
    {
      accessorKey: 'totalHours',
      header: 'Hours',
      Cell: ({ cell }) => cell.getValue<number>().toFixed(2),
      size: 100,
    },
    {
      accessorKey: 'totalCost',
      header: 'Cost',
      Cell: ({ cell }) => formatCurrency(cell.getValue<number>()),
      size: 130,
    },
  ];

  const costTable = useMantineReactTable({
    columns: costColumns,
    data: costReport,
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      className: classes.tableHeaderCell,
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
  });

  const reportTotal = costReport.reduce((sum, r) => sum + r.totalCost, 0);
  const reportHours = costReport.reduce((sum, r) => sum + r.totalHours, 0);

  // suppress unused import warning for dayjs
  void dayjs;

  return (
    <>
      {/* ---- Section A: Overview Cards ---- */}
      <Title order={2} mb="md">Contract Dashboard</Title>

      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} mb="xl">
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Contracts</Text>
              <Text size="xl" fw={700}>{totalContracts}</Text>
            </div>
            <ThemeIcon color="blue" variant="light" size="lg" radius="md">
              <IconReportMoney size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Total Funded</Text>
              <Text size="xl" fw={700}>{formatCurrency(totalFunded)}</Text>
            </div>
            <ThemeIcon color="green" variant="light" size="lg" radius="md">
              <IconCash size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Total Spent</Text>
              <Text size="xl" fw={700}>{formatCurrency(totalSpent)}</Text>
            </div>
            <ThemeIcon color="orange" variant="light" size="lg" radius="md">
              <IconReceipt size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Remaining</Text>
              <Text size="xl" fw={700} c={totalRemaining < 0 ? 'red' : undefined}>
                {formatCurrency(totalRemaining)}
              </Text>
            </div>
            <ThemeIcon color={totalRemaining < 0 ? 'red' : 'teal'} variant="light" size="lg" radius="md">
              <IconChartBar size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* ---- Section B: Contract Summary Table ---- */}
      <Title order={3} mb="sm">Contract Budget Overview</Title>
      <MantineReactTable table={contractTable} />

      {/* ---- Section C: Period Cost Report ---- */}
      <Divider my="xl" />
      <Title order={3} mb="sm">Period Cost Report</Title>

      <Paper withBorder p="md" mb="xl">
        <Group align="flex-end" wrap="wrap" gap="md">
          <DateInput
            label="Start Date"
            value={reportStartDate}
            onChange={setReportStartDate}
            required
            style={{ minWidth: 160 }}
          />
          <DateInput
            label="End Date"
            value={reportEndDate}
            onChange={setReportEndDate}
            required
            style={{ minWidth: 160 }}
          />
          <Button
            onClick={handleGenerateReport}
            loading={isPending}
            disabled={!reportStartDate || !reportEndDate}
          >
            Generate Report
          </Button>
        </Group>
      </Paper>

      {!hasGeneratedReport && (
        <Paper withBorder p="xl" ta="center">
          <Text c="dimmed" size="lg">
            Select a date range and click &quot;Generate Report&quot; to view period costs.
          </Text>
        </Paper>
      )}

      {hasGeneratedReport && (
        <>
          <MantineReactTable table={costTable} />
          {costReport.length > 0 && (
            <Paper withBorder p="md" mt="sm">
              <Group justify="space-between">
                <Text fw={700}>Totals</Text>
                <Group gap="xl">
                  <Text fw={600}>{reportHours.toFixed(2)} hrs</Text>
                  <Text fw={700} size="lg">{formatCurrency(reportTotal)}</Text>
                </Group>
              </Group>
            </Paper>
          )}
        </>
      )}
    </>
  );
}
