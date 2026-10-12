'use client';

import { useState, useTransition } from 'react';
import {
  ActionIcon,
  Button,
  Drawer,
  Select,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Paper,
  SimpleGrid,
  Switch,
  Timeline,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import {
  IconSearch,
  IconEdit,
  IconClock,
  IconAlertTriangle,
  IconHistory,
} from '@tabler/icons-react';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import dayjs from 'dayjs';
import {
  getAuditEntries,
  getCellRevisionHistory,
  getClinsForFilter,
  type AuditEntry,
  type AuditFilters,
  type CellRevisionHistory,
} from '@/server/actions/audit';
import { REASON_CODES } from '@/lib/reason-codes';
import { formatDate, formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
// Side-effect import only — this module's one remaining rule is a `:global()` dark-mode
// selector for correction rows; no scoped class name from it is used in this file anymore.
import './AuditTrail.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContractOption = {
  id: string;
  name: string;
  contractNumber: string;
};

type UserOption = {
  id: string;
  fullName: string;
  email: string;
};

type ClinOption = {
  id: string;
  clinNumber: string;
  description: string | null;
};

type AuditSummary = {
  totalEntries: number;
  totalCorrections: number;
  totalLateEntries: number;
  uniqueUsers: number;
};

type Props = {
  initialSummary: AuditSummary;
  contracts: ContractOption[];
  users: UserOption[];
};

// Map reason codes to human-readable labels
const REASON_LABEL_MAP: Record<string, string> = {};
for (const rc of REASON_CODES) {
  REASON_LABEL_MAP[rc.value] = rc.label;
}

export function AuditTrailClient({ initialSummary, contracts, users }: Props) {
  const [isPending, startTransition] = useTransition();
  const [summary] = useState<AuditSummary>(initialSummary);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  // Filter state
  const [filterUserId, setFilterUserId] = useState<string | null>(null);
  const [filterContractId, setFilterContractId] = useState<string | null>(null);
  const [filterClinId, setFilterClinId] = useState<string | null>(null);
  const [filterStartDate, setFilterStartDate] = useState<string | null>(null);
  const [filterEndDate, setFilterEndDate] = useState<string | null>(null);
  const [filterReasonCode, setFilterReasonCode] = useState<string | null>(null);
  const [filterRevisionsOnly, setFilterRevisionsOnly] = useState(false);
  const [clinOptions, setClinOptions] = useState<ClinOption[]>([]);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [revisionHistory, setRevisionHistory] = useState<CellRevisionHistory | null>(null);

  // --- Filter handlers ---

  function handleContractFilterChange(contractId: string | null) {
    setFilterContractId(contractId);
    setFilterClinId(null);
    setClinOptions([]);
    if (!contractId) return;
    startTransition(async () => {
      const fetchedClins = await getClinsForFilter(contractId);
      setClinOptions(fetchedClins);
    });
  }

  function handleSearch() {
    startTransition(async () => {
      const filters: AuditFilters = {};
      if (filterUserId) filters.userId = filterUserId;
      if (filterContractId) filters.contractId = filterContractId;
      if (filterClinId) filters.clinId = filterClinId;
      if (filterStartDate) filters.startDate = new Date(filterStartDate);
      if (filterEndDate) filters.endDate = new Date(filterEndDate);
      if (filterReasonCode) filters.reasonCode = filterReasonCode;
      if (filterRevisionsOnly) filters.revisionsOnly = true;

      const results = await getAuditEntries(filters);
      setEntries(results);
      setHasSearched(true);
    });
  }

  function handleViewHistory(entry: AuditEntry) {
    setDrawerOpen(true);
    setRevisionHistory(null);
    startTransition(async () => {
      const history = await getCellRevisionHistory(
        entry.userId,
        entry.clinId,
        entry.entryDate,
        entry.indirectCodeId ?? null,
      );
      setRevisionHistory(history);
    });
  }

  // --- Table columns ---

  const columns: MRT_ColumnDef<AuditEntry>[] = [
    { accessorKey: 'userName', header: 'Employee' },
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
    },
    { accessorKey: 'clinNumber', header: 'CLIN' },
    {
      accessorKey: 'entryDate',
      header: 'Entry Date',
      Cell: ({ cell }) => formatDate(cell.getValue<Date>()),
    },
    {
      accessorKey: 'hours',
      header: 'Hours',
      Cell: ({ cell }) => {
        const val = cell.getValue<string>();
        const num = parseFloat(val);
        return isNaN(num) ? val : num.toFixed(2);
      },
    },
    {
      accessorKey: 'revisionNumber',
      header: 'Rev #',
      // Holds the revision badge AND the history trigger — replaces the old dedicated actions column.
      Cell: ({ cell, row }) => {
        const rev = cell.getValue<number>();
        return (
          <Group gap={6} wrap="nowrap">
            <Badge color={rev === 1 ? 'success' : 'warning'} size="sm">
              {rev}
            </Badge>
            <Tooltip label="View revision history">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="View revision history"
                onClick={() => handleViewHistory(row.original)}
              >
                <IconHistory size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        );
      },
    },
    {
      accessorKey: 'changeReasonCode',
      header: 'Reason',
      Cell: ({ cell }) => {
        const code = cell.getValue<string | null>();
        if (!code) return <Text size="sm" c="dimmed">—</Text>;
        const label = REASON_LABEL_MAP[code] ?? code;
        return (
          <Tooltip label={label}>
            <Badge color="gray" size="sm" tt="none" style={{ maxWidth: '100%' }}>
              {label}
            </Badge>
          </Tooltip>
        );
      },
    },
    {
      accessorKey: 'comment',
      header: 'Comment',
      Cell: ({ cell }) => {
        const val = cell.getValue<string | null>();
        if (!val) return <Text size="sm" c="dimmed">—</Text>;
        return (
          <Text size="sm" lineClamp={1} title={val} style={{ maxWidth: 280 }}>
            {val}
          </Text>
        );
      },
    },
    {
      accessorKey: 'createdAt',
      header: 'Entered At',
      Cell: ({ cell }) => formatDateTime(cell.getValue<Date>()),
    },
    {
      accessorKey: 'createdByName',
      header: 'Entered By',
      Cell: ({ cell }) => {
        const val = cell.getValue<string | null>();
        return val ?? <Text size="sm" c="dimmed">—</Text>;
      },
    },
  ];

  const table = useAppTable({
    columns,
    data: entries,
    enableGlobalFilter: true,
    // Content-based column widths: semantic layout lets each column size to its data (e.g. the
    // mostly-empty Reason column auto-shrinks) instead of the fixed-pixel grid that column pinning
    // forces. The revision-history trigger now lives in the Rev # cell, so there's no actions column.
    initialState: {
      // Verbose/redundant detail lives in the revision-history drawer; users can re-enable these via
      // the column-visibility toolbar button. Comment = long free-text; Entered By usually == Employee.
      columnVisibility: { comment: false, createdByName: false },
    },
    // Correction-row highlight: `data-correction` also drives AuditTrail.module.css's dark-mode
    // text-contrast rule — keep both in sync if this ever changes.
    mantineTableBodyRowProps: ({ row }) => ({
      'data-correction': row.original.revisionNumber > 1 ? 'true' : undefined,
      style: row.original.revisionNumber > 1
        ? {
            backgroundColor: 'light-dark(var(--mantine-color-warning-0), var(--mantine-color-warning-1))',
          }
        : undefined,
    }),
    state: {
      isLoading: isPending && hasSearched,
    },
  });

  return (
    <>
      {/* ---- Section A: Summary Cards ---- */}
      <PageHeader title="Audit Trail" />

      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} mb="xl">
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Total Entries</Text>
              <Text size="xl" fw={700}>{summary.totalEntries.toLocaleString('en-US')}</Text>
            </div>
            <ThemeIcon color="signal" variant="light" size="lg" radius="md">
              <IconClock size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Corrections</Text>
              <Text size="xl" fw={700}>{summary.totalCorrections.toLocaleString('en-US')}</Text>
            </div>
            <ThemeIcon color="warning" variant="light" size="lg" radius="md">
              <IconEdit size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Late Entries</Text>
              <Text size="xl" fw={700}>{summary.totalLateEntries.toLocaleString('en-US')}</Text>
            </div>
            <ThemeIcon color="warning" variant="light" size="lg" radius="md">
              <IconAlertTriangle size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Active Users</Text>
              <Text size="xl" fw={700}>{summary.uniqueUsers.toLocaleString('en-US')}</Text>
            </div>
            <ThemeIcon color="success" variant="light" size="lg" radius="md">
              <IconHistory size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* ---- Section B: Filters ---- */}
      <Paper withBorder p="md" mb="xl">
        <Title order={4} mb="sm">Search Filters</Title>
        <Group align="flex-end" wrap="wrap" gap="md">
          <Select
            label="Employee"
            placeholder="All employees"
            data={users.map((u) => ({ value: u.id, label: u.fullName }))}
            value={filterUserId}
            onChange={setFilterUserId}
            clearable
            searchable
            style={{ minWidth: 180 }}
          />
          <Select
            label="Contract"
            placeholder="All contracts"
            data={contracts.map((c) => ({
              value: c.id,
              label: `${c.name} (${c.contractNumber})`,
            }))}
            value={filterContractId}
            onChange={handleContractFilterChange}
            clearable
            searchable
            style={{ minWidth: 220 }}
          />
          <Select
            label="CLIN"
            placeholder={filterContractId ? 'All CLINs' : 'Select contract first'}
            data={clinOptions.map((c) => ({
              value: c.id,
              label: `${c.clinNumber}${c.description ? ' — ' + c.description : ''}`,
            }))}
            value={filterClinId}
            onChange={setFilterClinId}
            disabled={!filterContractId}
            clearable
            searchable
            style={{ minWidth: 180 }}
          />
          <DateInput
            label="Start Date"
            value={filterStartDate}
            onChange={setFilterStartDate}
            clearable
            style={{ minWidth: 150 }}
          />
          <DateInput
            label="End Date"
            value={filterEndDate}
            onChange={setFilterEndDate}
            clearable
            style={{ minWidth: 150 }}
          />
          <Select
            label="Reason Code"
            placeholder="All reasons"
            data={REASON_CODES.map((rc) => ({ value: rc.value, label: rc.label }))}
            value={filterReasonCode}
            onChange={setFilterReasonCode}
            clearable
            style={{ minWidth: 180 }}
          />
          <Switch
            label="Corrections only"
            checked={filterRevisionsOnly}
            onChange={(e) => setFilterRevisionsOnly(e.currentTarget.checked)}
            mt="xl"
          />
          <Button
            leftSection={<IconSearch size={16} />}
            onClick={handleSearch}
            loading={isPending}
          >
            Search
          </Button>
        </Group>
      </Paper>

      {/* ---- Section C: Results Table ---- */}
      {!hasSearched && (
        <Paper withBorder p="xl" ta="center">
          <Text c="dimmed" size="lg">
            Use the filters above and click &quot;Search&quot; to view audit entries.
          </Text>
        </Paper>
      )}

      {hasSearched && <MantineReactTable table={table} />}

      {hasSearched && entries.length === 500 && (
        <Text size="sm" c="dimmed" mt="xs" ta="center">
          Results limited to 500 entries. Narrow your filters for more specific results.
        </Text>
      )}

      {/* ---- Revision History Drawer ---- */}
      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        size="lg"
        title="Revision History"
      >
        <Stack>
          {revisionHistory === null && isPending && (
            <Text c="dimmed" size="sm">Loading revision history...</Text>
          )}

          {revisionHistory === null && !isPending && (
            <Text c="dimmed" size="sm">No revision data found.</Text>
          )}

          {revisionHistory && (
            <>
              <Paper withBorder p="sm">
                <Group>
                  <Text size="sm"><strong>Employee:</strong> {revisionHistory.userName}</Text>
                  <Text size="sm"><strong>CLIN:</strong> {revisionHistory.clinNumber}</Text>
                  <Text size="sm"><strong>Contract:</strong> {revisionHistory.contractName}</Text>
                  <Text size="sm"><strong>Date:</strong> {formatDate(revisionHistory.entryDate)}</Text>
                </Group>
              </Paper>

              <Title order={5} mt="md">
                {revisionHistory.revisions.length} Revision{revisionHistory.revisions.length !== 1 ? 's' : ''}
              </Title>

              <Timeline active={revisionHistory.revisions.length - 1} bulletSize={28} lineWidth={2}>
                {revisionHistory.revisions.map((rev) => (
                  <Timeline.Item
                    key={rev.id}
                    bullet={
                      <ThemeIcon
                        size={28}
                        radius="xl"
                        color={rev.revisionNumber === 1 ? 'success' : 'warning'}
                      >
                        {rev.revisionNumber === 1
                          ? <IconClock size={14} />
                          : <IconEdit size={14} />
                        }
                      </ThemeIcon>
                    }
                    title={
                      <Group gap="xs">
                        <Text fw={600} size="sm">Revision {rev.revisionNumber}</Text>
                        <Badge
                          color={rev.revisionNumber === 1 ? 'success' : 'warning'}
                          size="sm"
                        >
                          {rev.hours} hrs
                        </Badge>
                      </Group>
                    }
                  >
                    <Stack gap={4} mt={4}>
                      {rev.changeReasonCode && (
                        <Text size="xs" c="dimmed">
                          <strong>Reason:</strong> {REASON_LABEL_MAP[rev.changeReasonCode] ?? rev.changeReasonCode}
                        </Text>
                      )}
                      {rev.comment && (
                        <Text size="xs" c="dimmed">
                          <strong>Comment:</strong> {rev.comment}
                        </Text>
                      )}
                      <Text size="xs" c="dimmed">
                        Entered at {dayjs(rev.createdAt).format('MMM D, YYYY h:mm:ss A')}
                        {rev.createdByName ? ` by ${rev.createdByName}` : ''}
                      </Text>
                    </Stack>
                  </Timeline.Item>
                ))}
              </Timeline>
            </>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
