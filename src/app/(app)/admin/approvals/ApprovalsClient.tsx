'use client';

import { useState, useTransition } from 'react';
import {
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
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { approvePeriod, rejectPeriod, getScopedPeriods } from '@/server/actions/periods';
import { runAction } from '@/lib/run-action';
import { ReviewDecisionButtons } from '@/components/approvals/ReviewDecisionButtons';
import { getTimesheetForReview } from '@/server/actions/timesheet';
import { addDays, formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { formatDateTime } from '@/lib/format';
import { PERIOD_STATUS_COLOR, ROLE_COLOR } from '@/lib/ui/status-colors';
import { PageHeader } from '@/components/ui/PageHeader';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';

type Period = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: CalendarDate;
  periodNumDays: number;
  status: string;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
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
  workspaceTimezone: string;
};

export function ApprovalsClient({ initialPeriods, currentUserId, userRole, scopeInfo, workspaceTimezone }: Props) {
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
    setReviewData(null);

    startTransition(async () => {
      try {
        const data = await getTimesheetForReview(period.userId, period.periodStart);
        setReviewData(data);
      } catch (error) {
        // R2-12: don't crash to the error page on a load failure (e.g. a scope change
        // mid-session) — show an inline notification and close the drawer instead.
        notifications.show({
          title: 'Failed to load timesheet',
          message: String(error),
          color: 'red',
          icon: <IconX size={16} />,
        });
        setDrawerOpen(false);
      }
    });
  }

  function handleApprove() {
    if (!selectedPeriod) return;
    startTransition(async () => {
      setActionError(null);
      const result = await runAction(approvePeriod({
        periodId: selectedPeriod.id,
        comment: approveComment.trim() || undefined,
      }), { errorTitle: 'Approval Failed' });
      if (!result.ok) {
        setActionError(result.error); // the server's reason (e.g. another reviewer decided first)
        return;
      }
      try {
        const refreshed = await getScopedPeriods();
        setPeriods(refreshed);
        setDrawerOpen(false);
        notifications.show({
          title: 'Timesheet Approved',
          message: `${selectedPeriod.userName}'s timesheet has been approved.`,
          color: 'success',
          icon: <IconCheck size={16} />,
        });
      } catch {
        // Approved; only the list refresh failed.
        notifications.show({ title: 'Approved', message: 'Refresh the page to see the updated list.', color: 'warning' });
      }
    });
  }

  function handleReject() {
    if (!selectedPeriod || !rejectComment.trim()) return;
    startTransition(async () => {
      setActionError(null);
      const result = await runAction(rejectPeriod({
        periodId: selectedPeriod.id,
        comment: rejectComment.trim(),
      }), { errorTitle: 'Rejection Failed' });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      try {
        const refreshed = await getScopedPeriods();
        setPeriods(refreshed);
        setDrawerOpen(false);
        notifications.show({
          title: 'Timesheet Rejected',
          message: `${selectedPeriod.userName}'s timesheet has been returned for corrections.`,
          color: 'warning',
          icon: <IconX size={16} />,
        });
      } catch {
        notifications.show({ title: 'Returned', message: 'Refresh the page to see the updated list.', color: 'warning' });
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
      Cell: ({ row }) => {
        const start = row.original.periodStart;
        const end = addDays(start, row.original.periodNumDays - 1);
        return `${formatCalendarDate(start, 'MMM D')} – ${formatCalendarDate(end, 'MMM D, YYYY')}`;
      },
      size: 200,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      Cell: ({ row, cell }) => {
        const status = cell.getValue<string>() as keyof typeof PERIOD_STATUS_COLOR;
        const isSelfApproved = row.original.reviewedBy === row.original.userId;
        return (
          <Group gap={4} wrap="nowrap">
            <Badge color={PERIOD_STATUS_COLOR[status] ?? 'gray'}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
            {isSelfApproved && (status === 'approved' || status === 'rejected') && (
              <Badge color="gray" variant="light" size="sm">{status === 'approved' ? 'Self-approved' : 'Self-rejected'}</Badge>
            )}
          </Group>
        );
      },
      size: 200,
    },
    {
      accessorKey: 'submittedAt',
      header: 'Submitted',
      Cell: ({ cell }) => formatDateTime(cell.getValue<Date | null>(), workspaceTimezone),
      size: 180,
    },
  ];

  const table = useAppTable({
    columns,
    data: periods,
    enableRowActions: true,
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
    initialState: {
      sorting: [{ id: 'periodStart', desc: true }],
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        mantineTableHeadCellProps: { style: { textAlign: 'center' as const } },
        mantineTableBodyCellProps: { style: { textAlign: 'center' as const } },
      },
    },
  });

  // Build review table content
  let reviewContent = null;
  if (reviewData && selectedPeriod) {
    const numDays = selectedPeriod.periodNumDays;
    const start = selectedPeriod.periodStart;

    reviewContent = (
      <Stack mt="md">
        <Text fw={600} size="sm">Time Entries:</Text>
        <Table.ScrollContainer minWidth={600}>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Charge Code</Table.Th>
              {Array.from({ length: numDays }, (_, i) => (
                <Table.Th key={i} style={{ textAlign: 'center', fontSize: 11 }}>
                  {formatCalendarDate(addDays(start, i), 'M/D')}
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
        </Table.ScrollContainer>
      </Stack>
    );
  }

  return (
    <>
      <PageHeader title="Timesheet Approvals" />

      {/* Scope information banner */}
      {userRole === 'supervisor' && scopeInfo && (
        <Paper withBorder p="sm" mb="md" radius="md">
          <Group gap="xs" align="center" wrap="wrap">
            <Text size="sm" c="dimmed" component="span">
              <strong>Your Approval Scope:</strong> You can review timesheets for
            </Text>
            <Badge color="signal" size="sm">{scopeInfo.supervisedEmployeeCount}</Badge>
            <Text size="sm" c="dimmed" component="span">employees across</Text>
            <Badge color="success" size="sm">{scopeInfo.assignedClinCount}</Badge>
            <Text size="sm" c="dimmed" component="span">CLINs you are assigned to.</Text>
          </Group>
        </Paper>
      )}

      {userRole === 'admin' && (
        <Paper withBorder p="sm" mb="md" radius="md">
          <Group gap="xs" align="center">
            <Badge color={ROLE_COLOR.admin} size="sm">Admin</Badge>
            <Text size="sm" c="dimmed" component="span">
              You have full access to all employee timesheets.
            </Text>
          </Group>
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
        size="90%"
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
                <Badge color={PERIOD_STATUS_COLOR[selectedPeriod.status as keyof typeof PERIOD_STATUS_COLOR] ?? 'gray'}>
                  {selectedPeriod.status}
                </Badge>
                {selectedPeriod.reviewedBy === selectedPeriod.userId && (selectedPeriod.status === 'approved' || selectedPeriod.status === 'rejected') && (
                  <Badge color="gray" variant="light">{selectedPeriod.status === 'approved' ? 'Self-approved' : 'Self-rejected'}</Badge>
                )}
              </Group>
            </Paper>
          )}

          {reviewData === null && isPending && (
            <Text c="dimmed" size="sm">Loading timesheet data...</Text>
          )}

          {reviewContent}

          {actionError && (
            <Alert icon={<IconAlertCircle size={16} />} color="red">
              {actionError}
            </Alert>
          )}

          {(() => {
            if (selectedPeriod?.status !== 'submitted') return null;
            const isOwnPeriod = selectedPeriod.userId === currentUserId;
            // §0 (R2-7): admins may approve/reject their own period; supervisors and employees
            // may not — the server enforces this too, this only controls what's offered in the UI.
            const canReview = !isOwnPeriod || userRole === 'admin';

            if (!canReview) {
              return (
                <Alert icon={<IconAlertCircle size={16} />} color="warning">
                  You cannot approve or reject your own timesheet. Another admin or supervisor must review it.
                </Alert>
              );
            }

            return (
              <>
                {isOwnPeriod && (
                  <Alert icon={<IconAlertCircle size={16} />} color="signal">
                    This is your own timesheet. As an admin, you may approve or reject it — the
                    decision will be visibly marked &quot;Self-approved&quot;.
                  </Alert>
                )}
                <Textarea
                  label="Approval Comment (optional)"
                  placeholder="Any feedback for the employee..."
                  value={approveComment}
                  onChange={(e) => setApproveComment(e.currentTarget.value)}
                  style={{ maxWidth: 500 }}
                />

                <Textarea
                  label="Rejection Comment (required if rejecting)"
                  placeholder="Explain what needs to be corrected..."
                  value={rejectComment}
                  onChange={(e) => setRejectComment(e.currentTarget.value)}
                  style={{ maxWidth: 500 }}
                />

                <ReviewDecisionButtons
                  isOwnPeriod={isOwnPeriod}
                  canReject={Boolean(rejectComment.trim())}
                  pending={isPending}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              </>
            );
          })()}
        </Stack>
      </Drawer>
    </>
  );
}
