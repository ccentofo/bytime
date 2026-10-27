'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Modal,
  TextInput,
  Select,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Paper,
  Divider,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { IconEdit, IconPlus, IconToggleLeft, IconBan, IconCurrencyDollar } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import {
  createLaborCategory,
  updateLaborCategory,
  getAllLaborCategories,
  assignUserToLaborCategory,
  endUserLaborCategoryAssignment,
  getUserLaborCategoryAssignments,
} from '@/server/actions/labor-categories';
import { getClinsByContract } from '@/server/actions/clins';
import { formatDate } from '@/lib/format';
import { RECORD_STATUS_COLOR } from '@/lib/ui/status-colors';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatCalendarDate, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { rateDisplay, type RateChange, type RateSchedule, type RateScheduleView } from '@/lib/labor-rates';
import { RateScheduleModal } from './RateScheduleModal';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';

// ---------------------------------------------------------------------------
// Types (derived from server action return types)
// ---------------------------------------------------------------------------

type LaborCategory = {
  id: string;
  clinId: string;
  slinId: string | null;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
  clinNumber: string;
  clinDescription: string | null;
  contractName: string;
  contractNumber: string;
  slinNumber: string | null;
  /** Dated rates: hourlyRate / ceilingRate are the STARTING rate; these are the dated changes. */
  rateChanges: RateChange[];
};

type UserLcatAssignment = {
  id: string;
  userId: string;
  laborCategoryId: string;
  effectiveDate: CalendarDate;
  endDate: CalendarDate | null;
  createdAt: Date;
  userName: string;
  userEmail: string;
  lcatCode: string;
  lcatTitle: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
};

type AssignableLcat = {
  id: string;
  lcatCode: string;
  title: string;
  clinId: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
};

type Contract = {
  id: string;
  contractNumber: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'closed';
  startDate: CalendarDate | null;
  endDate: CalendarDate | null;
  createdAt: Date;
  updatedAt: Date;
};

type User = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type Clin = {
  id: string;
  contractId: string;
  clinNumber: string;
  description: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
};

type LcatForm = {
  contractId: string | null;
  clinId: string | null;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate: string;
};

type Props = {
  initialLaborCategories: LaborCategory[];
  initialAssignments: UserLcatAssignment[];
  contracts: Contract[];
  users: User[];
  assignableLcats: AssignableLcat[];
  /** The workspace's today (server — never the browser clock), for the current-rate display. */
  today: CalendarDate;
};

const EMPTY_LCAT_FORM: LcatForm = {
  contractId: null,
  clinId: null,
  lcatCode: '',
  title: '',
  hourlyRate: '',
  ceilingRate: '',
};

function formatRate(rate: string | null): string {
  if (!rate) return '—';
  const num = parseFloat(rate);
  if (isNaN(num)) return '—';
  return `$${num.toFixed(2)}`;
}

export function LaborCategoriesClient({
  initialLaborCategories,
  initialAssignments,
  contracts,
  users,
  assignableLcats: initialAssignableLcats,
  today,
}: Props) {
  const canWrite = useCanWrite();
  const [isPending, startTransition] = useTransition();
  const [laborCats, setLaborCats] = useState<LaborCategory[]>(initialLaborCategories);
  const [assignments, setAssignments] = useState<UserLcatAssignment[]>(initialAssignments);
  const [assignableLcats] = useState<AssignableLcat[]>(initialAssignableLcats);

  // Dated rates D2: the Rates modal and the current-rate lookups (all from the same laborCats state).
  const [ratesFor, setRatesFor] = useState<LaborCategory | null>(null);
  const scheduleOf = (lc: LaborCategory): RateSchedule => ({ starting: { hourlyRate: lc.hourlyRate, ceilingRate: lc.ceilingRate }, changes: lc.rateChanges ?? [] });
  const currentRateOf = (laborCategoryId: string): string | null => {
    const lc = laborCats.find((x) => x.id === laborCategoryId);
    return lc ? rateDisplay(scheduleOf(lc), today).current.hourlyRate : null;
  };
  function mergeSchedule(view: RateScheduleView) {
    setLaborCats((prev) => prev.map((lc) => (lc.id === view.laborCategoryId
      ? { ...lc, hourlyRate: view.starting.hourlyRate, ceilingRate: view.starting.ceilingRate, rateChanges: view.changes }
      : lc)));
  }

  // LCAT Modal state
  const [lcatModalOpen, setLcatModalOpen] = useState(false);
  const [editingLcat, setEditingLcat] = useState<LaborCategory | null>(null);
  const [lcatForm, setLcatForm] = useState<LcatForm>(EMPTY_LCAT_FORM);
  const [clinOptions, setClinOptions] = useState<{ value: string; label: string }[]>([]);

  // Assignment form state
  const [assignUserId, setAssignUserId] = useState<string | null>(null);
  const [assignLcatId, setAssignLcatId] = useState<string | null>(null);
  const [assignEffectiveDate, setAssignEffectiveDate] = useState<string | null>(null);
  const [assignEndDate, setAssignEndDate] = useState<string | null>(null);
  const [confirmDeactivateLcat, setConfirmDeactivateLcat] = useState<LaborCategory | null>(null);
  const [confirmEndAssignment, setConfirmEndAssignment] = useState<UserLcatAssignment | null>(null);
  // certified-outputs C3: optional INCLUSIVE end date (default today) — a promotion can end yesterday and start today.
  const [endAssignmentDate, setEndAssignmentDate] = useState<CalendarDate | null>(null);

  // --- LCAT Modal handlers ---

  function openAddLcatModal() {
    setEditingLcat(null);
    setLcatForm(EMPTY_LCAT_FORM);
    setClinOptions([]);
    setLcatModalOpen(true);
  }

  function openEditLcatModal(lcat: LaborCategory) {
    setEditingLcat(lcat);
    setLcatForm({
      contractId: null, // Will be set after CLIN lookup; not needed for edit
      clinId: lcat.clinId,
      lcatCode: lcat.lcatCode,
      title: lcat.title,
      hourlyRate: lcat.hourlyRate,
      ceilingRate: lcat.ceilingRate ?? '',
    });
    setLcatModalOpen(true);
  }

  function handleContractChange(contractId: string | null) {
    setLcatForm((f) => ({ ...f, contractId, clinId: null }));
    setClinOptions([]);
    if (!contractId) return;
    startTransition(async () => {
      const fetchedClins = await getClinsByContract(contractId);
      setClinOptions(
        (fetchedClins as Clin[]).map((c) => ({
          value: c.id,
          label: `${c.clinNumber}${c.description ? ' — ' + c.description : ''}`,
        }))
      );
    });
  }

  function handleLcatSubmit() {
    // Dated rates D1.6: editing never sends rates (they change only through the Rates schedule); create sets the starting rate.
    if (!lcatForm.lcatCode.trim() || !lcatForm.title.trim() || (!editingLcat && !lcatForm.hourlyRate.trim())) return;

    startTransition(async () => {
      try {
        if (editingLcat) {
          const result = await runAction(updateLaborCategory(editingLcat.id, {
            lcatCode: lcatForm.lcatCode.trim(),
            title: lcatForm.title.trim(),
          }), { errorTitle: 'Couldn’t update labor category' });
          if (!result.ok) return;
          notifications.show({
            title: 'Labor Category Updated',
            message: `${lcatForm.lcatCode} has been updated.`,
            color: 'success',
          });
        } else {
          if (!lcatForm.clinId) return;
          const result = await runAction(createLaborCategory({
            clinId: lcatForm.clinId,
            lcatCode: lcatForm.lcatCode.trim(),
            title: lcatForm.title.trim(),
            hourlyRate: lcatForm.hourlyRate.trim(),
            ceilingRate: lcatForm.ceilingRate.trim() || undefined,
          }), { errorTitle: 'Couldn’t create labor category' });
          if (!result.ok) return;
          notifications.show({
            title: 'Labor Category Created',
            message: `${lcatForm.lcatCode} has been created.`,
            color: 'success',
          });
        }

        const refreshed = await getAllLaborCategories();
        setLaborCats(refreshed as LaborCategory[]);
        setLcatModalOpen(false);
      } catch {
        notifications.show({
          title: 'Error',
          message: 'Something went wrong. Please refresh and try again.',
          color: 'red',
        });
      }
    });
  }

  function handleToggleStatus(lcat: LaborCategory) {
    const newStatus = lcat.status === 'active' ? 'inactive' : 'active';
    startTransition(async () => {
      try {
        const result = await runAction(updateLaborCategory(lcat.id, { status: newStatus }), { errorTitle: 'Couldn’t update status' });
        if (!result.ok) return;
        const refreshed = await getAllLaborCategories();
        setLaborCats(refreshed as LaborCategory[]);
        notifications.show({
          title: 'Status Updated',
          message: `${lcat.lcatCode} is now ${newStatus}.`,
          color: newStatus === 'active' ? 'success' : 'gray',
        });
        setConfirmDeactivateLcat(null);
      } catch {
        notifications.show({
          title: 'Error',
          message: 'Something went wrong. Please refresh and try again.',
          color: 'red',
        });
      }
    });
  }

  // --- Assignment handlers ---

  function handleAssignSubmit() {
    if (!assignUserId || !assignLcatId || !assignEffectiveDate) return;
    startTransition(async () => {
      try {
        if (!isCalendarDate(assignEffectiveDate)) return;
        const endDate: CalendarDate | undefined = assignEndDate && isCalendarDate(assignEndDate) ? assignEndDate : undefined;
        const result = await runAction(assignUserToLaborCategory({
          userId: assignUserId,
          laborCategoryId: assignLcatId,
          effectiveDate: assignEffectiveDate,
          endDate,
        }), { errorTitle: 'Assignment Failed' });
        if (!result.ok) return;
        const refreshed = await getUserLaborCategoryAssignments();
        setAssignments(refreshed);
        setAssignUserId(null);
        setAssignLcatId(null);
        setAssignEffectiveDate(null);
        setAssignEndDate(null);
        notifications.show({
          title: 'Assignment Created',
          message: 'User has been assigned to the labor category.',
          color: 'success',
        });
      } catch {
        notifications.show({
          title: 'Assignment Failed',
          message: 'Something went wrong. Please refresh and try again.',
          color: 'red',
        });
      }
    });
  }

  function handleEndAssignment(assignment: UserLcatAssignment) {
    startTransition(async () => {
      try {
        const result = await runAction(endUserLaborCategoryAssignment(assignment.id, endAssignmentDate ?? undefined), { errorTitle: 'Couldn’t end assignment' });
        if (!result.ok) return;
        const refreshed = await getUserLaborCategoryAssignments();
        setAssignments(refreshed);
        notifications.show({
          title: 'Assignment Ended',
          message: `${assignment.userName}'s assignment to ${assignment.lcatCode} has been ended.`,
          color: 'warning',
        });
        setConfirmEndAssignment(null);
        setEndAssignmentDate(null);
      } catch {
        notifications.show({
          title: 'Error',
          message: 'Something went wrong. Please refresh and try again.',
          color: 'red',
        });
      }
    });
  }

  // --- LCAT Table columns ---

  const lcatColumns: MRT_ColumnDef<LaborCategory>[] = [
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 220,
    },
    { accessorKey: 'clinNumber', header: 'CLIN', size: 100 },
    {
      accessorKey: 'slinNumber',
      header: 'SLIN',
      size: 100,
      Cell: ({ cell }) => cell.getValue<string | null>() ?? '—',
    },
    { accessorKey: 'lcatCode', header: 'LCAT Code', size: 120 },
    { accessorKey: 'title', header: 'Title', size: 200 },
    {
      id: 'hourlyRate',
      header: 'Hourly Rate',
      // The rate in effect today, and the next later change (dimmed) if one exists.
      Cell: ({ row }) => {
        const { current, next } = rateDisplay(scheduleOf(row.original), today);
        return (
          <Stack gap={0}>
            <Text size="sm" data-testid="lcat-current-hourly">{formatRate(current.hourlyRate)}</Text>
            {next && <Text size="xs" c="dimmed" data-testid="lcat-next-hourly">→ {formatRate(next.hourlyRate)} from {formatCalendarDate(next.effectiveDate, 'MMM D, YYYY')}</Text>}
          </Stack>
        );
      },
      size: 150,
    },
    {
      id: 'ceilingRate',
      header: 'Ceiling Rate',
      Cell: ({ row }) => {
        const { current, next } = rateDisplay(scheduleOf(row.original), today);
        return (
          <Stack gap={0}>
            <Text size="sm">{formatRate(current.ceilingRate)}</Text>
            {next && <Text size="xs" c="dimmed">→ {formatRate(next.ceilingRate)} from {formatCalendarDate(next.effectiveDate, 'MMM D, YYYY')}</Text>}
          </Stack>
        );
      },
      size: 150,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      Cell: ({ cell }) => {
        const status = cell.getValue<string>() as keyof typeof RECORD_STATUS_COLOR;
        return <Badge color={RECORD_STATUS_COLOR[status] ?? 'gray'}>{status}</Badge>;
      },
      size: 110,
    },
  ];

  const lcatTable = useAppTable({
    columns: lcatColumns,
    data: laborCats,
    enableRowActions: true,
    renderRowActions: ({ row }) => (
      <Group gap="xs" wrap="nowrap" justify="center">
        <Tooltip label="Edit">
          <ActionIcon disabled={!canWrite} variant="subtle" onClick={() => openEditLcatModal(row.original)} aria-label="Edit labor category">
            <IconEdit size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Rates">
          <ActionIcon disabled={!canWrite} variant="subtle" onClick={() => setRatesFor(row.original)} aria-label="Rates">
            <IconCurrencyDollar size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={row.original.status === 'active' ? 'Deactivate' : 'Activate'}>
          <ActionIcon disabled={!canWrite}
            variant="subtle"
            color={row.original.status === 'active' ? 'red' : 'success'}
            onClick={() =>
              row.original.status === 'active'
                ? setConfirmDeactivateLcat(row.original)
                : handleToggleStatus(row.original)
            }
            aria-label={row.original.status === 'active' ? 'Deactivate labor category' : 'Activate labor category'}
          >
            <IconToggleLeft size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    ),
  });

  // --- Assignment Table columns ---

  const assignmentColumns: MRT_ColumnDef<UserLcatAssignment>[] = [
    { accessorKey: 'userName', header: 'Employee', size: 180 },
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 200,
    },
    { accessorKey: 'clinNumber', header: 'CLIN', size: 100 },
    {
      id: 'lcat',
      header: 'LCAT',
      accessorFn: (row) => `${row.lcatCode} — ${row.lcatTitle}`,
      size: 200,
    },
    {
      id: 'currentRate',
      header: 'Rate',
      // The assigned category's CURRENT rate (from its schedule in laborCats), never a starting rate.
      accessorFn: (row) => currentRateOf(row.laborCategoryId),
      Cell: ({ cell }) => `${formatRate(cell.getValue<string | null>())}/hr`,
      size: 120,
    },
    {
      accessorKey: 'effectiveDate',
      header: 'Effective Date',
      Cell: ({ cell }) => formatDate(cell.getValue<CalendarDate>()),
      size: 140,
    },
    {
      accessorKey: 'endDate',
      header: 'End Date',
      Cell: ({ cell }) => formatDate(cell.getValue<CalendarDate | null>()),
      size: 140,
    },
  ];

  const assignmentTable = useAppTable({
    columns: assignmentColumns,
    data: assignments,
    enableRowActions: true,
    renderRowActions: ({ row }) => (
      <Tooltip label={row.original.endDate ? 'Ended' : 'End assignment'}>
        <ActionIcon
          variant="subtle"
          color="warning"
          onClick={() => setConfirmEndAssignment(row.original)}
          disabled={!canWrite || (row.original.endDate !== null)}
          aria-label="End labor category assignment"
        >
          <IconBan size={16} />
        </ActionIcon>
      </Tooltip>
    ),
  });

  return (
    <>
      {/* ---- Section A: Labor Categories ---- */}
      <PageHeader
        title="Labor Categories"
        actions={
          <WriteButton leftSection={<IconPlus size={16} />} onClick={openAddLcatModal}>
            Add Labor Category
          </WriteButton>
        }
      />
      <MantineReactTable table={lcatTable} />

      {/* ---- Add/Edit LCAT Modal ---- */}
      <Modal
        opened={lcatModalOpen}
        onClose={() => setLcatModalOpen(false)}
        title={editingLcat ? 'Edit Labor Category' : 'Add Labor Category'}
        size="md"
      >
        <Stack>
          {!editingLcat && (
            <>
              <Select
                label="Contract"
                placeholder="Select contract"
                data={contracts.map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.contractNumber})`,
                }))}
                value={lcatForm.contractId}
                onChange={handleContractChange}
                searchable
              />
              <Select
                label="CLIN"
                placeholder={lcatForm.contractId ? 'Select CLIN' : 'Select a contract first'}
                data={clinOptions}
                value={lcatForm.clinId}
                onChange={(val) => setLcatForm((f) => ({ ...f, clinId: val }))}
                disabled={!lcatForm.contractId || clinOptions.length === 0}
                searchable
              />
            </>
          )}
          {editingLcat && (
            <Text size="sm" c="dimmed">
              Editing LCAT for CLIN {editingLcat.clinNumber} on {editingLcat.contractName}
            </Text>
          )}
          <TextInput
            label="LCAT Code"
            required
            placeholder="SE-III"
            value={lcatForm.lcatCode}
            onChange={(e) => setLcatForm((f) => ({ ...f, lcatCode: e.target.value }))}
          />
          <TextInput
            label="Title"
            required
            placeholder="Senior Engineer III"
            value={lcatForm.title}
            onChange={(e) => setLcatForm((f) => ({ ...f, title: e.target.value }))}
          />
          {!editingLcat && (
            <>
              <TextInput
                label="Starting hourly rate ($)"
                required
                placeholder="125.00"
                value={lcatForm.hourlyRate}
                onChange={(e) => setLcatForm((f) => ({ ...f, hourlyRate: e.target.value }))}
              />
              <TextInput
                label="Starting ceiling rate ($)"
                placeholder="150.00 (optional)"
                value={lcatForm.ceilingRate}
                onChange={(e) => setLcatForm((f) => ({ ...f, ceilingRate: e.target.value }))}
              />
            </>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setLcatModalOpen(false)}>
              Cancel
            </Button>
            <WriteButton
              onClick={handleLcatSubmit}
              loading={isPending}
              disabled={
                !lcatForm.lcatCode.trim() ||
                !lcatForm.title.trim() ||
                (!editingLcat && !lcatForm.hourlyRate.trim()) ||
                (!editingLcat && !lcatForm.clinId)
              }
            >
              {editingLcat ? 'Save Changes' : 'Create'}
            </WriteButton>
          </Group>
        </Stack>
      </Modal>

      {/* ---- Section B: User LCAT Assignments ---- */}
      <Divider my="xl" />
      <Title order={4} mb="lg">User Labor Category Assignments</Title>

      <Paper withBorder p="md" mb="xl">
        <Title order={4} mb="sm">Create Assignment</Title>
        <Group align="flex-end" wrap="wrap">
          <Select
            label="User"
            placeholder="Select employee"
            data={users.map((u) => ({ value: u.id, label: u.fullName }))}
            value={assignUserId}
            onChange={setAssignUserId}
            searchable
            style={{ minWidth: 200 }}
          />
          <Select
            label="Labor Category"
            placeholder="Select labor category"
            data={assignableLcats.map((lc) => ({
              value: lc.id,
              label: `${lc.contractName} — ${lc.clinNumber} — ${lc.lcatCode}: ${lc.title} (${formatRate(currentRateOf(lc.id))}/hr)`,
            }))}
            value={assignLcatId}
            onChange={setAssignLcatId}
            searchable
            style={{ minWidth: 400 }}
          />
          <DateInput
            label="Effective Date"
            value={assignEffectiveDate}
            onChange={setAssignEffectiveDate}
            required
            style={{ minWidth: 160 }}
          />
          <DateInput
            label="End Date"
            value={assignEndDate}
            onChange={setAssignEndDate}
            clearable
            style={{ minWidth: 160 }}
          />
          <WriteButton
            onClick={handleAssignSubmit}
            loading={isPending}
            disabled={!assignUserId || !assignLcatId || !assignEffectiveDate}
          >
            Assign
          </WriteButton>
        </Group>
      </Paper>

      <MantineReactTable table={assignmentTable} />

      <RateScheduleModal
        opened={!!ratesFor}
        onClose={() => setRatesFor(null)}
        category={ratesFor ? { id: ratesFor.id, lcatCode: ratesFor.lcatCode, title: ratesFor.title, schedule: scheduleOf(ratesFor) } : null}
        canWrite={canWrite}
        onSaved={mergeSchedule}
      />

      <ConfirmModal
        opened={!!confirmDeactivateLcat}
        title="Deactivate labor category?"
        message={confirmDeactivateLcat ? `This deactivates ${confirmDeactivateLcat.lcatCode} — ${confirmDeactivateLcat.title}.` : ''}
        confirmLabel="Deactivate"
        loading={isPending}
        onConfirm={() => confirmDeactivateLcat && handleToggleStatus(confirmDeactivateLcat)}
        onCancel={() => setConfirmDeactivateLcat(null)}
      />

      <Modal
        opened={!!confirmEndAssignment}
        onClose={() => { setConfirmEndAssignment(null); setEndAssignmentDate(null); }}
        title="End assignment?"
      >
        {confirmEndAssignment && (
          <Stack>
            <Text size="sm">
              This ends {confirmEndAssignment.userName}&apos;s assignment to {confirmEndAssignment.lcatCode}. The last day is
              included; leave the date empty to end it today. It can&apos;t be before the assignment&apos;s effective date.
            </Text>
            <DateInput
              label="Last day (optional)"
              value={endAssignmentDate}
              onChange={(d) => setEndAssignmentDate(d && isCalendarDate(d) ? d : null)}
              clearable
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => { setConfirmEndAssignment(null); setEndAssignmentDate(null); }}>Cancel</Button>
              <WriteButton color="warning" loading={isPending} onClick={() => handleEndAssignment(confirmEndAssignment)}>End Assignment</WriteButton>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
