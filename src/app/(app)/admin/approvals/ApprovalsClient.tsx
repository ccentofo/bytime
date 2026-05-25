'use client';

import { useState, useTransition } from 'react';
import {
  Title,
  Badge,
  Button,
  Drawer,
  Stack,
  Text,
  Textarea,
  Group,
  Paper,
  Table,
  Alert,
} from '@mantine/core';
import { IconCheck, IconX, IconEye, IconAlertCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import dayjs from 'dayjs';
import { approvePeriod, rejectPeriod, getScopedPeriods } from '@/server/actions/periods';
import { getSupervisedEmployeeIds } from '@/server/actions/supervisor-scope';
import { getTimesheetForReview } from '@/server/actions/timesheet';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';
import classes from "./Approvals.module.css";

type Period = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: string;
  submittedAt: Date | null;
  reviewedAt: Date | null;
};

type ScopeInfo = {
  assignedContractCount: number;
  assignedClinCount: number;
  supervisedEmployeeCount: number;
} | null;

type Props = {
  initialPeriods: Period[];
  currentUserId: string;
  userRole: string;
  scopeInfo: ScopeInfo;
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'yellow',
  submitted: 'blue',
  approved: 'green',
  rejected: 'red',
};

export function ApprovalsClient({ initialPeriods, currentUserId, userRole, scopeInfo }: Props) {
  const [periods, setPeriods] = useState(initialPeriods);
  const [isPending, startTransition] = useTransition();

  // Review drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState<Period | null>(null);
  const [reviewData, setReviewData] = useState<{
    chargeCodes: ChargeCode[];
    entries: TimesheetEntry[];
  } | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [approveComment, setApproveComment] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  function openReview(period: Period) {
    setSelectedPeriod(period);
    setDrawerOpen(true);
    setRejectComment('');
    setApproveComment('');
    setActionError(null);

    startTransition(async () => {
      const data = await getTimesheetForReview(period.userId, period.periodStart);
      setReviewData(data);
    });
  }

  function handleApprove() {
    if (!selectedPeriod) return;
    startTransition(async () => {
      try {
        setActionError(null);
        await approvePeriod({
          periodId: selectedPeriod.id,
          reviewedBy: currentUserId,
          comment: approveComment.trim() || undefined,
        });
        const scopedIds = await getSupervisedEmployeeIds(currentUserId, userRole);
        const refreshed = await getScopedPeriods(scopedIds);
        setPeriods(refreshed);
        setDrawerOpen(false);
        notifications.show({
          title: 'Timesheet Approved',
          message: `${selectedPeriod.userName}'s timesheet has been approved.`,
          color: 'green',
          icon: <IconCheck size={16} />,
        });
      } catch (error) {
        setActionError(String(error));
        notifications.show({
          title: 'Approval Failed',
          message: 'Failed to approve timesheet. Please try again.',
          color: 'red',
          icon: <IconX size={16} />,
        });
      }
    });
  }

  function handleReject() {
    if (!selectedPeriod || !rejectComment.trim()) return;
    startTransition(async () => {
      try {
        setActionError(null);
        await rejectPeriod({
          periodId: selectedPeriod.id,
          reviewedBy: currentUserId,
          comment: rejectComment.trim(),
        });
        const scopedIds = await getSupervisedEmployeeIds(currentUserId, userRole);
        const refreshed = await getScopedPeriods(scopedIds);
        setPeriods(refreshed);
        setDrawerOpen(false);
        notifications.show({
          title: 'Timesheet Rejected',
          message: `${selectedPeriod.userName}'s timesheet has been returned for corrections.`,
          color: 'orange',
          icon: <IconX size={16} />,
        });
      } catch (error) {
        setActionError(String(error));
        notifications.show({
          title: 'Rejection Failed',
          message: 'Failed to reject timesheet. Please try again.',
          color: 'red',
          icon: <IconX size={16} />,
        });
      }
    });
  }

  const columns: MRT_ColumnDef<Period>[] = [
    {
      accessorKey: 'userName',
      header: 'Employee',
      size: 180,
    },
    {
      accessorKey: 'periodStart',
      header: 'Pay Period',
      Cell: ({ cell }) => {
        const start = dayjs(cell.getValue<Date>());
        const numDays = getNumDaysInPeriod(start.toDate());
        const end = start.add(numDays - 1, 'day');
        return `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;
      },
      size: 200,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      Cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return (
          <Badge color={STATUS_COLORS[status] ?? 'gray'}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </Badge>
        );
      },
      size: 130,
    },
    {
      accessorKey: 'submittedAt',
      header: 'Submitted',
      Cell: ({ cell }) => {
        const val = cell.getValue<Date | null>();
        return val ? dayjs(val).format('MMM D, YYYY h:mm A') : '—';
      },
      size: 180,
    },
  ];

  const table = useMantineReactTable({
    columns,
    data: periods,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Button
        size="xs"
        variant="subtle"
        leftSection={<IconEye size={14} />}
        onClick={() => openReview(row.original)}
        disabled={row.original.status === 'draft'}
      >
        Review
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
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
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

  // Build review table content
  let reviewContent = null;
  if (reviewData && selectedPeriod) {
    const numDays = getNumDaysInPeriod(selectedPeriod.periodStart);
    const start = dayjs(selectedPeriod.periodStart);

    reviewContent = (
      <Stack mt="md">
        <Text fw={600} size="sm">Time Entries:</Text>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Charge Code</Table.Th>
              {Array.from({ length: numDays }, (_, i) => (
                <Table.Th key={i} style={{ textAlign: 'center', fontSize: 11 }}>
                  {start.add(i, 'day').format('M/D')}
                </Table.Th>
              ))}
              <Table.Th style={{ textAlign: 'center' }}>Total</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {reviewData.chargeCodes.map((cc) => {
              const entry = reviewData.entries.find((e) => e.chargeCodeId === cc.id);
              const hours = entry?.hours ?? [];
              const total = hours.reduce((a, b) => a + b, 0);
              return (
                <Table.Tr key={cc.id}>
                  <Table.Td>{cc.clin} — {cc.projectName}</Table.Td>
                  {Array.from({ length: numDays }, (_, i) => (
                    <Table.Td key={i} style={{ textAlign: 'center' }}>
                      {(hours[i] ?? 0) === 0 ? '—' : (hours[i] ?? 0).toFixed(2)}
                    </Table.Td>
                  ))}
                  <Table.Td style={{ textAlign: 'center', fontWeight: 700 }}>
                    {total.toFixed(2)}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Stack>
    );
  }

  return (
    <>
      <Title order={2} mb="md">Timesheet Approvals</Title>

      {/* Scope information banner */}
      {userRole === 'supervisor' && scopeInfo && (
        <Paper withBorder p="sm" mb="md" radius="md">
          <Group gap="lg">
            <Text size="sm" c="dimmed">
              <strong>Your Approval Scope:</strong> You can review timesheets for{' '}
              <Badge variant="light" color="blue" size="sm">{scopeInfo.supervisedEmployeeCount}</Badge>{' '}
              employees across{' '}
              <Badge variant="light" color="green" size="sm">{scopeInfo.assignedClinCount}</Badge>{' '}
              CLINs you are assigned to.
            </Text>
          </Group>
        </Paper>
      )}

      {userRole === 'admin' && (
        <Paper withBorder p="sm" mb="md" radius="md">
          <Text size="sm" c="dimmed">
            <Badge variant="light" color="red" size="sm">Admin</Badge>{' '}
            You have full access to all employee timesheets.
          </Text>
        </Paper>
      )}

      {/* Empty state for supervisors with no assignments */}
      {userRole === 'supervisor' && scopeInfo && scopeInfo.supervisedEmployeeCount === 0 && (
        <Paper withBorder p="xl" ta="center" radius="md">
          <Text size="lg" c="dimmed" mb="sm">No Employees in Your Scope</Text>
          <Text size="sm" c="dimmed">
            You are not assigned to any CLINs, so there are no employees whose timesheets you can review.
            Contact your administrator to get assigned to the appropriate contracts and CLINs.
          </Text>
        </Paper>
      )}

      <MantineReactTable table={table} />

      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        size="xl"
        title={
          selectedPeriod
            ? `Review — ${selectedPeriod.userName}`
            : 'Review Timesheet'
        }
      >
        <Stack>
          {selectedPeriod && (
            <Paper withBorder p="sm">
              <Group>
                <Text size="sm"><strong>Employee:</strong> {selectedPeriod.userName}</Text>
                <Text size="sm"><strong>Email:</strong> {selectedPeriod.userEmail}</Text>
                <Badge color={STATUS_COLORS[selectedPeriod.status] ?? 'gray'}>
                  {selectedPeriod.status}
                </Badge>
              </Group>
            </Paper>
          )}

          {reviewData === null && isPending && (
            <Text c="dimmed" size="sm">Loading timesheet data...</Text>
          )}

          {reviewContent}

          {actionError && (
            <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
              {actionError}
            </Alert>
          )}

          {selectedPeriod?.status === 'submitted' && (
            <>
              <Textarea
                label="Approval Comment (optional)"
                placeholder="Any feedback for the employee..."
                value={approveComment}
                onChange={(e) => setApproveComment(e.currentTarget.value)}
              />

              <Textarea
                label="Rejection Comment (required if rejecting)"
                placeholder="Explain what needs to be corrected..."
                value={rejectComment}
                onChange={(e) => setRejectComment(e.currentTarget.value)}
              />

              <Group justify="flex-end" mt="md">
                <Button
                  color="red"
                  variant="light"
                  leftSection={<IconX size={16} />}
                  onClick={handleReject}
                  disabled={!rejectComment.trim()}
                  loading={isPending}
                >
                  Reject
                </Button>
                <Button
                  color="green"
                  leftSection={<IconCheck size={16} />}
                  onClick={handleApprove}
                  loading={isPending}
                >
                  Approve
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
