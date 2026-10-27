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
  /** certified-outputs C2: the session user may decide it now (else "view but not approve"). */
  canApprove: boolean;
  /** approvalLabel(): "Self-approved"/"Self-rejected" badge and the approval line (server-formatted). */
  approvalBadge: string | null;
  approvalText: string | null;
};

type ScopeInfo = {
  assignedContractCount: number;
  assignedClinCount: number;
  supervisedEmployeeCount: number;
  designatedByCount: number;
} | null;

type ReviewData = {
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  periodStatus: string;
  /** C2: the version reviewed — sent back as `seen` so only this version can be decided. */
  submissionCount: number;
  canApprove: boolean;
  approvalBadge: string | null;
  approvalText: string | null;
};

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
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);
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
    if (!selectedPeriod || !reviewData) return; // decide only what has been loaded and reviewed
    startTransition(async () => {
      setActionError(null);
      const result = await runAction(approvePeriod({
        periodId: selectedPeriod.id,
        comment: approveComment.trim() || undefined,
        seen: reviewData.submissionCount,
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
    if (!selectedPeriod || !reviewData || !rejectComment.trim()) return;
    startTransition(async () => {
      setActionError(null);
      const result = await runAction(rejectPeriod({
        periodId: selectedPeriod.id,
        comment: rejectComment.trim(),
        seen: reviewData.submissionCount,
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
        return (
          <Group gap={4} wrap="nowrap">
            <Badge color={PERIOD_STATUS_COLOR[status] ?? 'gray'}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
            {row.original.approvalBadge && (
              <Badge color="gray" variant="light" size="sm">{row.original.approvalBadge}</Badge>
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
                  <Table.Td>
                    {cc.clin} — {cc.projectName}
                    {!cc.assignable && <Text size="xs" c="dimmed">No longer assigned (recorded hours shown)</Text>}
                  </Table.Td>
                  {Array.from({ length: numDays }, (_, i) => {
                    // certified-outputs C1 display: imported hours are labelled in the review too.
                    const provenance = entry?.provenance?.[i] ?? null;
                    return (
                      <Table.Td key={i} style={{ textAlign: 'center' }} title={provenance ?? undefined}>
                        {(hours[i] ?? 0) === 0 ? '—' : (hours[i] ?? 0).toFixed(2)}
                        {provenance && <Text span size="xs" c="signal" data-testid="imported-indicator"> •</Text>}
                      </Table.Td>
                    );
                  })}
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
            <Text size="sm" c="dimmed" component="span">CLINs you are assigned to</Text>
            {scopeInfo.designatedByCount > 0 && (
              <Text size="sm" c="dimmed" component="span">
                , including {scopeInfo.designatedByCount} {scopeInfo.designatedByCount === 1 ? 'person who has' : 'people who have'} designated you as their approver
              </Text>
            )}
            <Text size="sm" c="dimmed" component="span">.</Text>
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
            You are not assigned to any CLINs and nobody has designated you as their approver, so there are no
            timesheets you can review. Contact your administrator to get assigned to the appropriate contracts and CLINs.
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
                {(reviewData?.approvalBadge ?? selectedPeriod.approvalBadge) && (
                  <Badge color="gray" variant="light">{reviewData?.approvalBadge ?? selectedPeriod.approvalBadge}</Badge>
                )}
              </Group>
              {(reviewData?.approvalText ?? selectedPeriod.approvalText) && (
                <Text size="sm" c="dimmed" mt={4}>{reviewData?.approvalText ?? selectedPeriod.approvalText}</Text>
              )}
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
            // C2: Approve/Reject stay unavailable until the review data (and the version it shows) has loaded.
            if (!reviewData) return null;
            const isOwnPeriod = selectedPeriod.userId === currentUserId;

            // R2-7: supervisors and employees never decide their own period (the server enforces this too).
            if (isOwnPeriod && userRole !== 'admin') {
              return (
                <Alert icon={<IconAlertCircle size={16} />} color="warning">
                  You cannot approve or reject your own timesheet. Another admin or supervisor must review it.
                </Alert>
              );
            }
            // C2 (CO-D6/CO-D12): an admin's own timesheet once a second admin or a designated approver exists.
            if (isOwnPeriod && !reviewData.canApprove) {
              return (
                <Alert icon={<IconAlertCircle size={16} />} color="warning">
                  Your timesheet must be approved by another admin or your designated approver.
                </Alert>
              );
            }
            if (!reviewData.canApprove) {
              return (
                <Alert icon={<IconAlertCircle size={16} />} color="gray">
                  You can view but not approve this timesheet.
                </Alert>
              );
            }

            return (
              <>
                {isOwnPeriod && (
                  <Alert icon={<IconAlertCircle size={16} />} color="signal">
                    This is your own timesheet. You are the only active admin and have no designated approver, so you
                    may approve or reject it — the decision is visibly marked as a self-approval everywhere it appears.
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
