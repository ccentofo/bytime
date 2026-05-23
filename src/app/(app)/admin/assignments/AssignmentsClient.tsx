'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Select,
  Group,
  Stack,
  Title,
  Badge,
  Paper,
} from '@mantine/core';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { getClinsByContract } from '@/server/actions/clins';
import { assignUserToClin, unassignUserFromClin, getAssignments } from '@/server/actions/assignments';

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
  startDate: Date | null;
  endDate: Date | null;
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
  isActive: boolean;
  assignedAt: Date;
  userName: string;
  userEmail: string;
  clinNumber: string;
  clinDescription: string | null;
  contractName: string;
  contractNumber: string;
};

type Props = {
  initialAssignments: Assignment[];
  users: User[];
  contracts: Contract[];
};

export function AssignmentsClient({ initialAssignments, users, contracts }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [assignments, setAssignments] = useState<Assignment[]>(initialAssignments);

  // Form state
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const [selectedClinId, setSelectedClinId] = useState<string | null>(null);
  const [clinOptions, setClinOptions] = useState<{ value: string; label: string }[]>([]);

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
    });
  }

  const columns: MRT_ColumnDef<Assignment>[] = [
    { accessorKey: 'userName', header: 'Employee', size: 180 },
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 220,
    },
    { accessorKey: 'clinNumber', header: 'CLIN', size: 100 },
    {
      accessorKey: 'isActive',
      header: 'Status',
      filterVariant: 'checkbox',
      Cell: ({ cell }) => (
        <Badge color={cell.getValue<boolean>() ? 'green' : 'gray'}>
          {cell.getValue<boolean>() ? 'Active' : 'Inactive'}
        </Badge>
      ),
      size: 100,
    },
    {
      accessorKey: 'assignedAt',
      header: 'Assigned Date',
      Cell: ({ cell }) => new Date(cell.getValue<Date>()).toLocaleDateString(),
      size: 140,
    },
  ];

  const table = useMantineReactTable({
    columns,
    data: assignments,
    enableColumnFilters: true,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Button
        size="xs"
        variant="subtle"
        color={row.original.isActive ? 'red' : 'green'}
        onClick={() => handleDeactivate(row.original)}
        loading={isPending}
        disabled={!row.original.isActive}
      >
        Deactivate
      </Button>
    ),
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
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
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 110,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
  });

  return (
    <>
      <Title order={2} mb="md">User Assignments</Title>

      {/* Section A: Create Assignment Form */}
      <Paper withBorder p="md" mb="xl">
        <Title order={4} mb="sm">Create Assignment</Title>
        <Group align="flex-end" wrap="wrap">
          <Select
            label="User"
            placeholder="Select employee"
            data={users.map((u) => ({ value: u.id, label: u.fullName }))}
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

      {/* Section B: Assignments Table */}
      <MantineReactTable table={table} />
    </>
  );
}
