'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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
  SegmentedControl,
  List,
  VisuallyHidden,
} from '@mantine/core';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { notifications } from '@mantine/notifications';
import { MantineReactTable, type MRT_ColumnDef, type MRT_SortingState } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { approvePeriod, rejectPeriod, getScopedPeriods } from '@/server/actions/periods';
import { runAction } from '@/lib/run-action';
import { ReviewDecisionButtons } from '@/components/approvals/ReviewDecisionButtons';
import { getTimesheetForReview } from '@/server/actions/timesheet';
import { addDays, formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { formatDateTime } from '@/lib/format';
import { PERIOD_STATUS_COLOR } from '@/lib/ui/status-colors';
import { rowLabel } from '@/lib/timesheet/labels';
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
  /** UX-2 §4.6: submissions so far, and the "Worth a look" flags (decidable rows only). */
  submissionCount?: number;
  flags?: { corrections: number; lateEntries: number; resubmitted: boolean } | null;
};

type ScopeInfo = {
  assignedContractCount: number;
  assignedClinCount: number;
  /** n: people approvable through a shared CLIN who did not designate this supervisor. */
  approvableEmployeeCount: number;
  /** k: people who designated this supervisor. n + k = Home's team. */
  designatedByCount: number;
} | null;

export type ApprovalsView = 'waiting' | 'decided' | 'everything';

/** Which rows each view shows (UX-2 §4.6). Drafts never show. */
export function rowsForView(view: ApprovalsView, rows: Period[]): Period[] {
  if (view === 'waiting') return rows.filter((r) => r.canApprove);
  if (view === 'decided') return rows.filter((r) => r.status === 'approved' || r.status === 'rejected');
  return rows.filter((r) => r.status !== 'draft');
}

/** Waiting: oldest submitted first; the others: newest period first. Controlled, so it resets with the view. */
const SORT_FOR: Record<ApprovalsView, MRT_SortingState> = {
  waiting: [{ id: 'submittedAt', desc: false }],
  decided: [{ id: 'periodStart', desc: true }],
  everything: [{ id: 'periodStart', desc: true }],
};

/** Why a submitted period isn't yours to decide (only for submitted rows with !canApprove). */
export function reasonChip(row: Pick<Period, 'status' | 'canApprove' | 'userId'>, currentUserId: string, userRole: string): string | null {
  if (row.status !== 'submitted' || row.canApprove) return null;
  if (row.userId === currentUserId) {
    return userRole === 'admin' ? 'Your own — another admin or designee approves' : 'Your own — needs another approver';
  }
  return 'Approved by an admin or their designee';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "You review 3 people on 1 CLIN and 2 people who designated you" (UX-2 ruling: n and k never overlap). */
export function scopeSentence(info: NonNullable<ScopeInfo>): string {
  const designators = `${plural(info.designatedByCount, 'person', 'people')} who designated you`;
  // Only designators (nobody via a shared CLIN): no CLIN clause (UX-2 fix round 1, L2).
  if (info.approvableEmployeeCount === 0 && info.designatedByCount > 0) return `You review ${designators}`;
  const base = `You review ${plural(info.approvableEmployeeCount, 'person', 'people')} on ${plural(info.assignedClinCount, 'CLIN', 'CLINs')}`;
  return info.designatedByCount > 0 ? `${base} and ${designators}` : base;
}

function flagWords(flags: NonNullable<Period['flags']>): string[] {
  const out: string[] = [];
  if (flags.corrections > 0) out.push(plural(flags.corrections, 'correction', 'corrections'));
  if (flags.lateEntries > 0) out.push(plural(flags.lateEntries, 'late entry', 'late entries'));
  if (flags.resubmitted) out.push('Resubmitted');
  return out;
}

type ReviewData = {
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  periodStatus: string;
  /** C2: the version reviewed — sent back as `seen` so only this version can be decided. */
  submissionCount: number;
  canApprove: boolean;
  approvalBadge: string | null;
  approvalText: string | null;
  /** UX-3 A4.3: the period's latest notes, keyed `${chargeCodeId}-${dayIndex}` (missing → none). */
  notes?: Record<string, { body: string; revision: number }>;
};

/** One line of the drawer's Notes list (feature-plan-ux-timesheet-ui.md §4.12). */
export interface ReviewNote { dayIndex: number; rowIndex: number; key: string; text: string }

/**
 * The drawer's Notes list (§4.12): non-empty notes only, sorted by date then row, each
 * "{ddd, MMM D} · {code} {rowName} · {body}"; a note whose row isn't in the review reads "Removed code".
 */
export function reviewNotes(notes: ReviewData['notes'], chargeCodes: ChargeCode[], start: CalendarDate): ReviewNote[] {
  const out: ReviewNote[] = [];
  for (const [key, note] of Object.entries(notes ?? {})) {
    if (!note?.body) continue;
    const dash = key.lastIndexOf('-');                       // charge-code ids contain dashes; the day index doesn't
    const id = key.slice(0, dash);
    const dayIndex = Number(key.slice(dash + 1));
    if (dash < 0 || !Number.isInteger(dayIndex)) continue;
    const rowIndex = chargeCodes.findIndex((cc) => cc.id === id);
    const cc = chargeCodes[rowIndex];
    const row = cc ? rowLabel(cc) : 'Removed code';
    out.push({ dayIndex, rowIndex: rowIndex < 0 ? chargeCodes.length : rowIndex, key, text: `${formatCalendarDate(addDays(start, dayIndex), 'ddd, MMM D')} · ${row} · ${note.body}` });
  }
  return out.sort((a, b) => a.dayIndex - b.dayIndex || a.rowIndex - b.rowIndex || a.key.localeCompare(b.key));
}

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
  const router = useRouter();
  const [view, setView] = useState<ApprovalsView>('waiting');
  const [sorting, setSorting] = useState<MRT_SortingState>(SORT_FOR.waiting);
  function changeView(next: ApprovalsView) {
    setView(next);
    setSorting(SORT_FOR[next]);
  }

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
          icon: <Icons.statusError size={ICON_SIZE.button} />,
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
      router.refresh(); // the sidebar's waiting count lives in the layout (UX-2 §4.6)
      try {
        const refreshed = await getScopedPeriods();
        setPeriods(refreshed);
        setDrawerOpen(false);
        notifications.show({
          title: 'Timesheet Approved',
          message: `${selectedPeriod.userName}'s timesheet has been approved.`,
          color: 'success',
          icon: <Icons.approve size={ICON_SIZE.button} />,
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
      router.refresh(); // the sidebar's waiting count lives in the layout (UX-2 §4.6)
      try {
        const refreshed = await getScopedPeriods();
        setPeriods(refreshed);
        setDrawerOpen(false);
        notifications.show({
          title: 'Timesheet Rejected',
          message: `${selectedPeriod.userName}'s timesheet has been returned for corrections.`,
          color: 'warning',
          icon: <Icons.reject size={ICON_SIZE.button} />,
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
            {reasonChip(row.original, currentUserId, userRole) && (
              <Badge color="gray" variant="outline" size="sm" data-testid="reason-chip">{reasonChip(row.original, currentUserId, userRole)}</Badge>
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
    {
      id: 'flags',
      header: 'Worth a look',
      enableSorting: false,
      accessorFn: (row) => (row.flags ? flagWords(row.flags).join(' ') : ''),
      Cell: ({ row }) => {
        const words = row.original.flags ? flagWords(row.original.flags) : [];
        if (words.length === 0) return <Text size="sm" c="dimmed">Nothing unusual</Text>;
        return (
          <Group gap={4} wrap="wrap">
            {words.map((w) => <Badge key={w} color="warning" variant="light" size="sm">{w}</Badge>)}
          </Group>
        );
      },
      size: 200,
    },
  ];

  const waitingCount = useMemo(() => rowsForView('waiting', periods).length, [periods]);
  // Memoized: a new data array on every render makes MRT re-render forever.
  const viewRows = useMemo(() => rowsForView(view, periods), [view, periods]);
  const table = useAppTable({
    columns,
    data: viewRows,
    enableRowActions: true,
    // Review decides; View opens the drawer read-only (the existing decision gating still applies there).
    renderRowActions: ({ row }) => (
      <Button
        size="xs"
        variant="subtle"
        leftSection={<Icons.view size={14} />}
        onClick={() => openReview(row.original)}
      >
        {row.original.canApprove ? 'Review' : 'View'}
      </Button>
    ),
    // Controlled sorting: a fixed initialState would override the per-view order.
    state: { sorting, columnVisibility: { flags: view === 'waiting' } },
    onSortingChange: setSorting,
    localization: { noRecordsToDisplay: view === 'waiting' ? 'Nothing is waiting for you.' : 'Nothing here yet.' },
  });

  // Build review table content
  let reviewContent = null;
  if (reviewData && selectedPeriod) {
    const numDays = selectedPeriod.periodNumDays;
    const start = selectedPeriod.periodStart;
    const notes = reviewData.notes ?? {};
    const noteLines = reviewNotes(notes, reviewData.chargeCodes, start);

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
                    {rowLabel(cc)}
                    {!cc.assignable && <Text size="xs" c="dimmed">Closed to new hours (recorded hours shown)</Text>}
                  </Table.Td>
                  {Array.from({ length: numDays }, (_, i) => {
                    // certified-outputs C1 display: imported hours are labelled in the review too.
                    const provenance = entry?.provenance?.[i] ?? null;
                    return (
                      <Table.Td key={i} style={{ textAlign: 'center' }} title={provenance ?? undefined}>
                        {(hours[i] ?? 0) === 0 ? '—' : (hours[i] ?? 0).toFixed(2)}
                        {provenance && <Text span size="xs" c="signal" data-testid="imported-indicator"> •</Text>}
                        {notes[`${cc.id}-${i}`]?.body && (
                          <span data-testid="note-indicator">
                            {' '}<Icons.note size={12} aria-hidden="true" /><VisuallyHidden>, note</VisuallyHidden>
                          </span>
                        )}
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
        {noteLines.length > 0 && (
          <>
            <Text fw={600} size="sm" id="review-notes-heading">Notes</Text>
            <List size="sm" spacing={4} aria-labelledby="review-notes-heading" data-testid="review-notes">
              {noteLines.map((n) => <List.Item key={n.key}>{n.text}</List.Item>)}
            </List>
          </>
        )}
      </Stack>
    );
  }

  return (
    <>
      <PageHeader title="Timesheet Approvals" />

      {/* Scope sentence (supervisors): the people they can approve, never counted twice (UX-2 ruling). */}
      {userRole === 'supervisor' && scopeInfo && scopeInfo.approvableEmployeeCount + scopeInfo.designatedByCount > 0 && (
        <Text size="sm" c="dimmed" mb="md" data-testid="scope-sentence">{scopeSentence(scopeInfo)}.</Text>
      )}

      {/* Empty state for supervisors with nobody to review */}
      {userRole === 'supervisor' && scopeInfo && scopeInfo.approvableEmployeeCount + scopeInfo.designatedByCount === 0 && (
        <Paper withBorder p="xl" ta="center" radius="md">
          <Text size="lg" c="dimmed" mb="sm">No Employees in Your Scope</Text>
          <Text size="sm" c="dimmed">
            You are not assigned to any CLINs and nobody has designated you as their approver, so there are no
            timesheets you can review. Contact your administrator to get assigned to the appropriate contracts and CLINs.
          </Text>
        </Paper>
      )}

      <SegmentedControl
        mb="md"
        value={view}
        onChange={(v) => changeView(v as ApprovalsView)}
        data={[
          { value: 'waiting', label: `Waiting for you (${waitingCount})` },
          { value: 'decided', label: 'Decided' },
          { value: 'everything', label: 'Everything' },
        ]}
        aria-label="Which timesheets to show"
      />

      <MantineReactTable table={table} />

      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        size="90%"
        title={
          selectedPeriod
            ? `${selectedPeriod.canApprove ? 'Review' : 'View'} — ${selectedPeriod.userName}`
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
            <Alert icon={<Icons.statusError size={ICON_SIZE.button} />} color="red">
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
                <Alert icon={<Icons.statusWarning size={ICON_SIZE.button} />} color="warning">
                  You cannot approve or reject your own timesheet. Another admin or supervisor must review it.
                </Alert>
              );
            }
            // C2 (CO-D6/CO-D12): an admin's own timesheet once a second admin or a designated approver exists.
            if (isOwnPeriod && !reviewData.canApprove) {
              return (
                <Alert icon={<Icons.statusWarning size={ICON_SIZE.button} />} color="warning">
                  Your timesheet must be approved by another admin or your designated approver.
                </Alert>
              );
            }
            if (!reviewData.canApprove) {
              return (
                <Alert icon={<Icons.statusInfo size={ICON_SIZE.button} />} color="gray">
                  You can view but not approve this timesheet.
                </Alert>
              );
            }

            return (
              <>
                {isOwnPeriod && (
                  <Alert icon={<Icons.statusInfo size={ICON_SIZE.button} />} color="signal">
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
