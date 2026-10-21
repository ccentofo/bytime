'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  Button,
  Select,
  Group,
  Title,
  Badge,
  Paper,
  Tabs,
  Text,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import { IconBan } from '@tabler/icons-react';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { getClinsByContract } from '@/server/actions/clins';
import { assignUserToClin, unassignUserFromClin, getAssignments } from '@/server/actions/assignments';
import {
  assignChargeCodeToUser,
  unassignChargeCodeFromUser,
  assignAllUnderClin,
  getChargeCodeAssignments,
} from '@/server/actions/charge-codes';
import { formatDateTime } from '@/lib/format';
import { RECORD_STATUS_COLOR, WORK_LOCATION_COLOR } from '@/lib/ui/status-colors';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PageHeader } from '@/components/ui/PageHeader';
import type { CalendarDate } from '@/lib/calendar-date';

type User = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
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

type Clin = {
  id: string;
  contractId: string;
  clinNumber: string;
  description: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
};

type Assignment = {
  id: string;
  userId: string;
  clinId: string;
  slinId: string | null;
  isActive: boolean;
  assignedAt: Date;
  userName: string;
  userEmail: string;
  clinNumber: string;
  clinDescription: string | null;
  contractName: string;
  contractNumber: string;
  slinNumber: string | null;
  slinDescription: string | null;
};

type ChargeCode = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  clinId: string;
  clinNumber: string;
  slinId: string | null;
  contractName: string;
  contractNumber: string;
  laborCategoryId: string | null;
  classId: string | null;
  className: string | null;
  workLocation: 'onsite' | 'telework' | 'other' | null;
  billable: boolean;
  isActive: boolean;
  createdAt: Date;
};

type ChargeCodeAssignment = {
  userId: string;
  userName: string;
  chargeCodeId: string;
  code: string;
  name: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
  workLocation: 'onsite' | 'telework' | 'other' | null;
  isActive: boolean;
  assignedAt: Date;
};

type Props = {
  initialAssignments: Assignment[];
  users: User[];
  contracts: Contract[];
  chargeCodes: ChargeCode[];
  initialChargeCodeAssignments: ChargeCodeAssignment[];
  workspaceTimezone: string;
};

export function AssignmentsClient({ initialAssignments, users, contracts, chargeCodes, initialChargeCodeAssignments, workspaceTimezone }: Props) {
  const [isPending, startTransition] = useTransition();
  const [assignments, setAssignments] = useState<Assignment[]>(initialAssignments);

  // Form state
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const [selectedClinId, setSelectedClinId] = useState<string | null>(null);
  const [clinOptions, setClinOptions] = useState<{ value: string; label: string }[]>([]);
  const [confirmClinTarget, setConfirmClinTarget] = useState<Assignment | null>(null);

  // Charge-code assignment section state
  const [ccAssignments, setCcAssignments] = useState<ChargeCodeAssignment[]>(initialChargeCodeAssignments);
  const [ccIsPending, startCcTransition] = useTransition();
  const [ccUserId, setCcUserId] = useState<string | null>(null);
  const [ccContractId, setCcContractId] = useState<string | null>(null);
  const [ccClinId, setCcClinId] = useState<string | null>(null);
  const [ccChargeCodeId, setCcChargeCodeId] = useState<string | null>(null);
  const [confirmCcTarget, setConfirmCcTarget] = useState<ChargeCodeAssignment | null>(null);

  // CLIN options for the charge-code form, derived from the same contract→CLIN data
  // already present in `chargeCodes` (avoids a second getClinsByContract round-trip).
  const ccClinOptionsForContract = ccContractId
    ? Array.from(
        new Map(
          chargeCodes
            .filter((cc) => cc.contractNumber === contracts.find((c) => c.id === ccContractId)?.contractNumber)
            .map((cc) => [cc.clinId, { value: cc.clinId, label: cc.clinNumber }])
        ).values()
      )
    : [];

  const ccChargeCodeOptions = ccClinId
    ? chargeCodes
        .filter((cc) => cc.clinId === ccClinId && cc.isActive)
        .map((cc) => ({ value: cc.id, label: `${cc.code} — ${cc.name}` }))
    : [];

  function handleCcContractChange(contractId: string | null) {
    setCcContractId(contractId);
    setCcClinId(null);
    setCcChargeCodeId(null);
  }

  function handleCcClinChange(clinId: string | null) {
    setCcClinId(clinId);
    setCcChargeCodeId(null);
  }

  function handleAssignChargeCode() {
    if (!ccUserId || !ccChargeCodeId) return;
    startCcTransition(async () => {
      await assignChargeCodeToUser(ccUserId, ccChargeCodeId);
      const refreshed = await getChargeCodeAssignments();
      setCcAssignments(refreshed as ChargeCodeAssignment[]);
      setCcUserId(null);
      setCcContractId(null);
      setCcClinId(null);
      setCcChargeCodeId(null);
    });
  }

  function handleAssignAllUnderClin() {
    if (!ccUserId || !ccClinId) return;
    startCcTransition(async () => {
      await assignAllUnderClin(ccUserId, ccClinId);
      const refreshed = await getChargeCodeAssignments();
      setCcAssignments(refreshed as ChargeCodeAssignment[]);
      setCcUserId(null);
      setCcContractId(null);
      setCcClinId(null);
      setCcChargeCodeId(null);
    });
  }

  function handleDeactivateChargeCode(assignment: ChargeCodeAssignment) {
    startCcTransition(async () => {
      await unassignChargeCodeFromUser(assignment.userId, assignment.chargeCodeId);
      const refreshed = await getChargeCodeAssignments();
      setCcAssignments(refreshed as ChargeCodeAssignment[]);
      setConfirmCcTarget(null);
    });
  }

  const ccColumns: MRT_ColumnDef<ChargeCodeAssignment>[] = [
    { accessorKey: 'userName', header: 'Employee', size: 180 },
    { accessorKey: 'code', header: 'Code', size: 160 },
    { accessorKey: 'name', header: 'Name', size: 200 },
    {
      id: 'contractClin',
      header: 'Contract / CLIN',
      accessorFn: (row) => `${row.contractNumber} / ${row.clinNumber}`,
      size: 180,
    },
    {
      accessorKey: 'workLocation',
      header: 'Work Location',
      size: 130,
      Cell: ({ cell }) => {
        const loc = cell.getValue<string | null>();
        return loc ? <Badge color={WORK_LOCATION_COLOR[loc] ?? 'gray'}>{loc}</Badge> : '—';
      },
    },
    {
      accessorKey: 'isActive',
      header: 'Status',
      filterVariant: 'checkbox',
      size: 100,
      Cell: ({ cell }) => {
        const active = cell.getValue<boolean>();
        return (
          <Badge color={active ? RECORD_STATUS_COLOR.active : RECORD_STATUS_COLOR.inactive}>
            {active ? 'Active' : 'Inactive'}
          </Badge>
        );
      },
    },
  ];

  const ccTable = useAppTable({
    columns: ccColumns,
    data: ccAssignments,
    enableColumnFilters: true,
    enableRowActions: true,
    renderRowActions: ({ row }) => (
      <Tooltip label="Deactivate">
        <ActionIcon
          variant="subtle"
          color="red"
          onClick={() => setConfirmCcTarget(row.original)}
          disabled={!row.original.isActive}
          aria-label="Deactivate charge code assignment"
        >
          <IconBan size={16} />
        </ActionIcon>
      </Tooltip>
    ),
    displayColumnDefOptions: {
      'mrt-row-actions': {
        mantineTableHeadCellProps: { style: { textAlign: 'center' as const } },
        mantineTableBodyCellProps: { style: { textAlign: 'center' as const } },
      },
    },
  });

  function handleContractChange(contractId: string | null) {
    setSelectedContractId(contractId);
    setSelectedClinId(null);
    setClinOptions([]);
    if (!contractId) return;
    startTransition(async () => {
      const clins = await getClinsByContract(contractId);
      setClinOptions(
        (clins as Clin[]).map((c) => ({
          value: c.id,
          label: `${c.clinNumber}${c.description ? ' — ' + c.description : ''}`,
        }))
      );
    });
  }

  function handleAssign() {
    if (!selectedUserId || !selectedClinId) return;
    startTransition(async () => {
      await assignUserToClin({ userId: selectedUserId, clinId: selectedClinId });
      const refreshed = await getAssignments();
      setAssignments(refreshed as Assignment[]);
      // Reset form
      setSelectedUserId(null);
      setSelectedContractId(null);
      setSelectedClinId(null);
      setClinOptions([]);
    });
  }

  function handleDeactivate(assignment: Assignment) {
    startTransition(async () => {
      await unassignUserFromClin(assignment.userId, assignment.clinId);
      const refreshed = await getAssignments();
      setAssignments(refreshed as Assignment[]);
      setConfirmClinTarget(null);
    });
  }

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const supervisorUsers = useMemo(() => users.filter((u) => u.role === 'supervisor'), [users]);
  const supervisorAssignments = useMemo(
    () => assignments.filter((a) => usersById.get(a.userId)?.role === 'supervisor'),
    [assignments, usersById]
  );

  const columns: MRT_ColumnDef<Assignment>[] = [
    { accessorKey: 'userName', header: 'Supervisor', size: 180 },
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
    {
      accessorKey: 'isActive',
      header: 'Status',
      filterVariant: 'checkbox',
      Cell: ({ cell }) => {
        const active = cell.getValue<boolean>();
        return (
          <Badge color={active ? RECORD_STATUS_COLOR.active : RECORD_STATUS_COLOR.inactive}>
            {active ? 'Active' : 'Inactive'}
          </Badge>
        );
      },
      size: 100,
    },
    {
      accessorKey: 'assignedAt',
      header: 'Assigned Date',
      Cell: ({ cell }) => formatDateTime(cell.getValue<Date>(), workspaceTimezone),
      size: 140,
    },
  ];

  const table = useAppTable({
    columns,
    data: supervisorAssignments,
    enableColumnFilters: true,
    enableRowActions: true,
    renderRowActions: ({ row }) => (
      <Tooltip label="Deactivate">
        <ActionIcon
          variant="subtle"
          color="red"
          onClick={() => setConfirmClinTarget(row.original)}
          disabled={!row.original.isActive}
          aria-label="Deactivate supervisor assignment"
        >
          <IconBan size={16} />
        </ActionIcon>
      </Tooltip>
    ),
    displayColumnDefOptions: {
      'mrt-row-actions': {
        mantineTableHeadCellProps: { style: { textAlign: 'center' as const } },
        mantineTableBodyCellProps: { style: { textAlign: 'center' as const } },
      },
    },
  });

  return (
    <>
      <PageHeader title="User Assignments" />

      <Tabs defaultValue="charge-codes">
        <Tabs.List mb="md">
          <Tabs.Tab value="charge-codes">Charge Code Access</Tabs.Tab>
          <Tabs.Tab value="approval-scope">Approval Scope</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="charge-codes">
          <Text size="sm" c="dimmed" mb="md">
            Authorize which charge codes each employee can charge time to. Assigning a code also
            grants the underlying CLIN access automatically.
          </Text>

          {/* Charge Code Assignment Form */}
          <Paper withBorder p="md" mb="xl">
            <Title order={4} mb="sm">Assign Charge Code</Title>
            <Group align="flex-end" wrap="wrap">
              <Select
                label="User"
                placeholder="Select employee"
                data={users.map((u) => ({ value: u.id, label: u.fullName }))}
                value={ccUserId}
                onChange={setCcUserId}
                searchable
                style={{ minWidth: 200 }}
              />
              <Select
                label="Contract"
                placeholder="Select contract"
                data={contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.contractNumber})` }))}
                value={ccContractId}
                onChange={handleCcContractChange}
                searchable
                style={{ minWidth: 260 }}
              />
              <Select
                label="CLIN"
                placeholder={ccContractId ? 'Select CLIN' : 'Select a contract first'}
                data={ccClinOptionsForContract}
                value={ccClinId}
                onChange={handleCcClinChange}
                disabled={!ccContractId || ccClinOptionsForContract.length === 0}
                searchable
                style={{ minWidth: 180 }}
              />
              <Select
                label="Charge Code"
                placeholder={ccClinId ? 'Select charge code' : 'Select a CLIN first'}
                data={ccChargeCodeOptions}
                value={ccChargeCodeId}
                onChange={setCcChargeCodeId}
                disabled={!ccClinId || ccChargeCodeOptions.length === 0}
                searchable
                style={{ minWidth: 240 }}
              />
              <Button
                onClick={handleAssignChargeCode}
                loading={ccIsPending}
                disabled={!ccUserId || !ccChargeCodeId}
              >
                Assign Code
              </Button>
              <Button
                variant="default"
                onClick={handleAssignAllUnderClin}
                loading={ccIsPending}
                disabled={!ccUserId || !ccClinId}
              >
                Assign all codes under CLIN
              </Button>
            </Group>
          </Paper>

          {/* Charge Code Assignments Table */}
          <MantineReactTable table={ccTable} />
        </Tabs.Panel>

        <Tabs.Panel value="approval-scope">
          <Text size="sm" c="dimmed" mb="md">
            Grant supervisors approval authority over the CLINs they oversee. A supervisor can
            review any employee who charges to a CLIN they&apos;re assigned to.
          </Text>

          {/* Assign Supervisor to CLIN Form */}
          <Paper withBorder p="md" mb="xl">
            <Title order={4} mb="sm">Assign Supervisor to CLIN</Title>
            <Group align="flex-end" wrap="wrap">
              <Select
                label="Supervisor"
                placeholder="Select supervisor"
                data={supervisorUsers.map((u) => ({ value: u.id, label: u.fullName }))}
                value={selectedUserId}
                onChange={setSelectedUserId}
                searchable
                style={{ minWidth: 200 }}
              />
              <Select
                label="Contract"
                placeholder="Select contract"
                data={contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.contractNumber})` }))}
                value={selectedContractId}
                onChange={handleContractChange}
                searchable
                style={{ minWidth: 260 }}
              />
              <Select
                label="CLIN"
                placeholder={selectedContractId ? 'Select CLIN' : 'Select a contract first'}
                data={clinOptions}
                value={selectedClinId}
                onChange={setSelectedClinId}
                disabled={!selectedContractId || clinOptions.length === 0}
                searchable
                style={{ minWidth: 220 }}
              />
              <Button
                onClick={handleAssign}
                loading={isPending}
                disabled={!selectedUserId || !selectedClinId}
              >
                Assign
              </Button>
            </Group>
          </Paper>

          {/* Supervisor Assignments Table */}
          <MantineReactTable table={table} />
        </Tabs.Panel>
      </Tabs>

      <ConfirmModal
        opened={!!confirmCcTarget}
        title="Deactivate charge code assignment?"
        message={
          confirmCcTarget
            ? `This removes ${confirmCcTarget.userName}'s access to ${confirmCcTarget.code} — ${confirmCcTarget.name}.`
            : ''
        }
        confirmLabel="Deactivate"
        loading={ccIsPending}
        onConfirm={() => confirmCcTarget && handleDeactivateChargeCode(confirmCcTarget)}
        onCancel={() => setConfirmCcTarget(null)}
      />

      <ConfirmModal
        opened={!!confirmClinTarget}
        title="Deactivate supervisor assignment?"
        message={
          confirmClinTarget
            ? `This removes ${confirmClinTarget.userName}'s approval scope over CLIN ${confirmClinTarget.clinNumber}.`
            : ''
        }
        confirmLabel="Deactivate"
        loading={isPending}
        onConfirm={() => confirmClinTarget && handleDeactivate(confirmClinTarget)}
        onCancel={() => setConfirmClinTarget(null)}
      />
    </>
  );
}
