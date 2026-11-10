'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Drawer, Group, List, Paper, SegmentedControl, Stack, Text, VisuallyHidden } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable, numericColumn } from '@/components/table/mrtDefaults';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PageHeader } from '@/components/ui/PageHeader';
import { useBusy } from '@/components/ui/useBusy';
import { ReviewGrid } from '@/components/approvals/ReviewGrid';
import { DecisionCard, RETURN_NEEDS_COMMENT } from '@/components/approvals/DecisionCard';
import { approvePeriod, rejectPeriod, getScopedPeriods } from '@/server/actions/periods';
import { getTimesheetForReview } from '@/server/actions/timesheet';
import { runAction } from '@/lib/run-action';
import { toastError, toastSuccess } from '@/lib/toast';
import { formatHours } from '@/lib/format';
import { addDays, calendarDayOf, formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { periodLabel, rowLabel, shownRowName } from '@/lib/timesheet/labels';
import { reasonLabel } from '@/lib/reason-codes';
import type { FlaggedCell, LastReturn } from '@/lib/approvals/flagged-cells';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';
import classes from './Approvals.module.css';

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
  flags?: { corrections: number; lateEntries: number; resubmitted: boolean; hours?: number } | null;
  /** UX-4b Part 2 §3.1.3: hours (Waiting rows only) and the decision as the UI words it (A1). */
  hours?: number | null;
  decidedByName?: string | null;
  decidedAtText?: string | null;
  approvalUiText?: string | null;
  approvalUiBadge?: string | null;
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

/**
 * Which rows each view shows (UX-2 §4.6), in its order. Drafts never show. Waiting keeps the server's compareWaiting
 * order (feature-plan-ux-approvals-payroll.md A3 — no client re-sort); Decided is newest decision first; Everything is
 * newest period first.
 */
export function rowsForView(view: ApprovalsView, rows: Period[]): Period[] {
  if (view === 'waiting') return rows.filter((r) => r.canApprove);
  const time = (d: Date | string | null) => (d ? new Date(d).getTime() : 0);
  if (view === 'decided') {
    return rows.filter((r) => r.status === 'approved' || r.status === 'rejected')
      .sort((a, b) => time(b.reviewedAt) - time(a.reviewedAt) || b.periodStart.localeCompare(a.periodStart));
  }
  return rows.filter((r) => r.status !== 'draft')
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.userName.localeCompare(b.userName));
}

const periodOf = (r: Pick<Period, 'periodStart' | 'periodNumDays'>) => periodLabel(r.periodStart, addDays(r.periodStart, r.periodNumDays - 1));

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

/** "Worth a look" (A4): only what matters; an empty list renders nothing. */
export function flagWords(flags: NonNullable<Period['flags']>): string[] {
  const out: string[] = [];
  if (flags.corrections > 0) out.push(plural(flags.corrections, 'correction', 'corrections'));
  if (flags.lateEntries > 0) out.push(plural(flags.lateEntries, 'late entry', 'late entries'));
  if (flags.resubmitted) out.push('Resubmitted after return');
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
  /** UX-4b Part 2 §3.1.5: the reviewed period row (A10 binding; null with no row), its length, the flags, the last return. */
  periodId?: string | null;
  numDays?: number;
  submittedAt?: string | null;
  submittedComment?: string | null;
  flagged?: FlaggedCell[];
  lastReturn?: LastReturn | null;
  approvalUiText?: string | null;
};

/** The grid on screen and whose it is (fix round 1, M1). */
type GridSnapshot = { periodId: string; start: CalendarDate; numDays: number; data: ReviewData; employeeName: string; periodText: string };
const gridOf = (row: Period, data: ReviewData): GridSnapshot =>
  ({ periodId: row.id, start: row.periodStart, numDays: data.numDays ?? row.periodNumDays, data, employeeName: row.userName, periodText: periodOf(row) });

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
  /** `?review={periodId}` (validated on the server): opened once on mount (§3.1.7). */
  initialReviewId?: string | null;
  /** ApprovalNotices, shown below the h1 (§3.2). */
  notices?: ReactNode;
};

export function ApprovalsClient({ initialPeriods, currentUserId, userRole, scopeInfo, workspaceTimezone, initialReviewId = null, notices = null }: Props) {
  const [periods, setPeriods] = useState(initialPeriods);
  const router = useRouter();
  const busy = useBusy();
  const [view, setView] = useState<ApprovalsView>('waiting');
  const narrow = useMediaQuery('(max-width: 40em)');
  const phone = useMediaQuery('(max-width: 48em)');
  const dayOf = (d: Date | string) => formatCalendarDate(calendarDayOf(new Date(d), workspaceTimezone), 'MMM D');
  const submittedDay = (d: Date | string | null) => (d ? dayOf(d) : '—');

  // ── The review Drawer (§3.3). `current` is what the Drawer describes; `reviewData` is the review read FOR it, or null
  // while a read is in flight or after it failed (A10: no decision without the review on screen). ────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [current, setCurrent] = useState<Period | null>(null);
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);
  /**
   * The last loaded grid stays visible while Previous / Next loads (the decision card shows "Loading…"). It carries its
   * own employee and period, so while it is kept its caption still names whose hours they are (fix round 1, M1).
   */
  const [grid, setGrid] = useState<GridSnapshot | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [openNext, setOpenNext] = useState(true);
  const readToken = useRef(0);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  /** The Drawer's heading: focus lands here when the focused button unmounts (open next, Retry — fix round 1, M2). */
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** The Drawer's polite live region: "Opened {employee}, {i} of {n} waiting" once a stepped-to review is ready. */
  const [announcement, setAnnouncement] = useState('');
  /** Where focus goes once the Drawer has closed (returnFocus is off; onExitTransitionEnd applies it). */
  const focusAfterClose = useRef<{ kind: 'heading' } | { kind: 'row'; id: string } | null>(null);

  const waitingCount = useMemo(() => rowsForView('waiting', periods).length, [periods]);
  // Memoized: a new data array on every render makes MRT re-render forever.
  const viewRows = useMemo(() => rowsForView(view, periods), [view, periods]);
  const waitingRows = useMemo(() => rowsForView('waiting', periods), [periods]);
  const firstWaitingId = view === 'waiting' ? viewRows[0]?.id ?? null : null;

  /**
   * Load `row`'s review. A response for an older request is dropped before any setState (request token). Previous /
   * Next and "open next" keep the last grid visible while loading (`keepGrid`) and pass the row's place in the Waiting
   * list, announced once the review is ready; opening from the list starts clean.
   */
  async function loadReview(row: Period, keepGrid = false, position?: { i: number; n: number }) {
    const token = ++readToken.current;
    if (!keepGrid) setGrid(null);
    setAnnouncement('');
    setCurrent(row);
    setReviewData(null);
    setReadError(null);
    setComment('');
    setCommentError(null);
    setDecisionError(null);
    setDrawerOpen(true);
    try {
      const data = await getTimesheetForReview(row.userId, row.periodStart);
      if (token !== readToken.current) return;
      setReviewData(data);
      setGrid(gridOf(row, data));
      if (position) setAnnouncement(`Opened ${row.userName}, ${position.i} of ${position.n} waiting`);
    } catch {
      if (token !== readToken.current) return;
      setGrid(null); // only the error and Retry — never another person's grid (M1)
      setReadError("This timesheet couldn't be loaded.");
    }
  }

  function closeDrawer() {
    if (busy.any()) return; // a decision is running (§3.3.3)
    readToken.current += 1;
    focusAfterClose.current = current && viewRows.some((r) => r.id === current.id) ? { kind: 'row', id: current.id } : { kind: 'heading' };
    setDrawerOpen(false);
  }

  function applyCloseFocus() {
    const target = focusAfterClose.current;
    focusAfterClose.current = null;
    if (!target) return;
    // By the row's id (fix round 1, L2) — never by its index among the rendered buttons.
    const button = target.kind === 'row'
      ? [...document.querySelectorAll<HTMLElement>('[data-review-button]')].find((el) => el.dataset.reviewButton === target.id)
      : undefined;
    if (button) { button.focus(); return; }
    const heading = document.querySelector<HTMLElement>('h1');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }

  // Previous / Next walk the Waiting list (in compareWaiting order) when the open row is in it.
  const navIndex = current && view === 'waiting' ? waitingRows.findIndex((r) => r.id === current.id) : -1;
  const navigable = navIndex >= 0;
  function step(delta: -1 | 1) {
    if (busy.any() || !navigable) return; // never move while a decision runs
    const next = waitingRows[navIndex + delta];
    if (next) void loadReview(next, true, { i: navIndex + delta + 1, n: waitingRows.length });
  }

  // A10: the card renders only for the review that is on screen — same object for the period id and the version seen.
  const reviewReady = !!(current && reviewData && reviewData.periodId === current.id);

  async function decide(kind: 'approve' | 'return') {
    if (!current || !reviewData || reviewData.periodId !== current.id || busy.any()) return;
    const trimmed = comment.trim();
    if (kind === 'return' && trimmed === '') {
      setCommentError(RETURN_NEEDS_COMMENT); // no request (§6)
      commentRef.current?.focus();
      return;
    }
    const decided = current;
    const snapshot = waitingRows.map((r) => r.id); // before deciding (§3.3.4)
    const position = viewRows.findIndex((r) => r.id === decided.id); // the decided row's place in this view
    await busy.run(`decision:${kind}`, async () => {
      if (!reviewData.periodId) return;
      setDecisionError(null);
      // A10: the period and the version seen come from the SAME review object — the one on screen.
      const result = kind === 'approve'
        ? await runAction(approvePeriod({ periodId: reviewData.periodId, seen: reviewData.submissionCount, comment: trimmed || undefined }), { silent: true })
        : await runAction(rejectPeriod({ periodId: reviewData.periodId, seen: reviewData.submissionCount, comment: trimmed }), { silent: true });
      if (!result.ok) { setDecisionError(result.error); return; } // the comment is kept
      toastSuccess({ title: kind === 'approve' ? 'Timesheet approved' : 'Timesheet returned', message: `${decided.userName} · ${periodOf(decided)}` });
      let rows: Period[];
      try {
        rows = (await getScopedPeriods()) as Period[];
      } catch {
        toastError({ title: 'List not refreshed', message: "Decided, but the list couldn't refresh. Reload the page." });
        router.refresh();
        focusAfterClose.current = { kind: 'heading' };
        setReviewData(null); // L3: nothing to click while the Drawer slides out
        setDrawerOpen(false);
        return;
      }
      setPeriods(rows);
      router.refresh(); // the sidebar's waiting count lives in the layout
      const stillWaiting = rowsForView('waiting', rows);
      const at = snapshot.indexOf(decided.id);
      if (!openNext) {
        // L2: the Review button of the row now at the decided row's place (else the heading).
        const there = position >= 0 ? rowsForView(view, rows)[position] : undefined;
        focusAfterClose.current = there ? { kind: 'row', id: there.id } : { kind: 'heading' };
        setReviewData(null);
        setDrawerOpen(false);
        return;
      }
      const after = snapshot.slice(at + 1).map((id) => stillWaiting.find((r) => r.id === id)).find(Boolean);
      const next = after ?? stillWaiting[0];
      if (next) {
        headingRef.current?.focus(); // before the focused button unmounts (M2)
        void loadReview(next, true, { i: stillWaiting.indexOf(next) + 1, n: stillWaiting.length });
        return;
      }
      focusAfterClose.current = { kind: 'heading' };
      setReviewData(null);
      setDrawerOpen(false);
    }, { group: 'decision' });
  }

  const columns = useMemo<MRT_ColumnDef<Period>[]>(() => {
    const employee: MRT_ColumnDef<Period> = { id: 'employee', header: 'Employee', accessorFn: (r) => r.userName, Cell: ({ row }) => <Text fw={600} size="sm" span>{row.original.userName}</Text> };
    const period: MRT_ColumnDef<Period> = { id: 'period', header: 'Pay period', accessorFn: (r) => periodOf(r) };
    const submitted: MRT_ColumnDef<Period> = { id: 'submitted', header: 'Submitted', accessorFn: (r) => submittedDay(r.submittedAt) };
    const status: MRT_ColumnDef<Period> = {
      id: 'status', header: 'Status', accessorFn: (r) => r.status,
      Cell: ({ row }) => {
        const chip = reasonChip(row.original, currentUserId, userRole);
        return (
          <Group gap={6} wrap="nowrap">
            <StatusBadge status={row.original.status} />
            {chip && <Text size="xs" c="dimmed" data-testid="reason-chip">{chip}</Text>}
          </Group>
        );
      },
    };
    if (view === 'waiting') {
      return [
        employee, period, submitted,
        numericColumn<Period>({ id: 'hours', header: 'Hours', accessorFn: (r) => r.hours ?? null, Cell: ({ row }) => formatHours(row.original.hours ?? null) }),
        {
          id: 'flags', header: 'Worth a look', accessorFn: (r) => (r.flags ? flagWords(r.flags).join(' ') : ''),
          // A4: only what matters; nothing at all when there's nothing unusual.
          Cell: ({ row }) => {
            const words = row.original.flags ? flagWords(row.original.flags) : [];
            return words.length === 0 ? null : <span className={classes.flags}>{words.map((w) => <span key={w} className={classes.flag}>{w}</span>)}</span>;
          },
        },
      ];
    }
    if (view === 'decided') {
      return [
        employee, period, status,
        {
          id: 'decidedBy', header: 'Decided by', accessorFn: (r) => r.decidedByName ?? '',
          Cell: ({ row }) => (
            <Group gap={6} wrap="nowrap">
              <span>{row.original.decidedByName ?? '—'}</span>
              {row.original.approvalUiBadge && <Text size="xs" c="dimmed" span>{row.original.approvalUiBadge}</Text>}
            </Group>
          ),
        },
        { id: 'decidedOn', header: 'Decided on', accessorFn: (r) => r.decidedAtText ?? '—' },
      ];
    }
    return [employee, period, status, submitted];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- submittedDay only reads workspaceTimezone
  }, [view, currentUserId, userRole, workspaceTimezone]);

  const table = useAppTable<Period>({
    columns,
    data: viewRows,
    hairline: true,
    compact: viewRows.length <= 25,
    enableSorting: false,
    // A3: Waiting keeps the compareWaiting order; the other views keep rowsForView's order (no client re-sort).
    // The columns change with the view, so the order is set each time (MRT would keep the previous view's). It also
    // shielded this table from the cross-table column-order leak fixed by feature-plan-hotfix-table-state.md; kept.
    state: { sorting: [], columnOrder: [...columns.map((c) => c.id!), 'mrt-row-actions'] },
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => {
      const review = row.original.canApprove;
      return (
        <Button
          size="xs"
          variant={review && row.original.id === firstWaitingId ? 'filled' : 'default'}
          onClick={() => { void loadReview(row.original); }}
          data-review-button={row.original.id}
        >
          {review ? 'Review' : 'View'}
        </Button>
      );
    },
    emptyState: view === 'waiting'
      ? { title: 'Nothing is waiting for you.', body: 'New timesheets appear here when employees submit.' }
      : view === 'decided' ? { title: 'No decided timesheets yet.' } : { title: 'Nothing here yet.' },
  });

  // §3.1.7: ?review= opens once (a ref survives StrictMode's double mount); the param leaves the URL through
  // history.replaceState (router.replace would re-run the page on the server); state is set only after the read.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (!initialReviewId || deepLinked.current) return;
    deepLinked.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete('review');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    const row = initialPeriods.find((p) => p.id === initialReviewId);
    if (!row) {
      toastError({ title: 'Timesheet not available', message: "That timesheet isn't available to you." });
      return;
    }
    const token = ++readToken.current;
    void (async () => {
      try {
        const data = await getTimesheetForReview(row.userId, row.periodStart);
        if (token !== readToken.current) return;
        setCurrent(row);
        setReviewData(data);
        setGrid(gridOf(row, data));
        setDrawerOpen(true);
      } catch {
        // L6: the read failed — not "isn't available" (that's only for an id not in the rows).
        toastError({ title: 'Timesheet not opened', message: "Couldn't open that timesheet. Try again." });
      }
    })();
  }, [initialReviewId, initialPeriods]);

  // ── Drawer content ──────────────────────────────────────────────────────────────────────────────────────────────
  const totalHours = reviewReady && reviewData
    ? reviewData.entries.reduce((s, e) => s + e.hours.reduce((a, b) => a + b, 0), 0)
    : current?.hours ?? null;
  const rowName = (id: string, codes: ChargeCode[]) => { const cc = codes.find((c) => c.id === id); return cc ? (shownRowName(cc) || cc.clin) : 'Removed code'; };
  const flagged = reviewReady ? reviewData!.flagged ?? [] : [];
  const lastReturn = reviewReady ? reviewData!.lastReturn ?? null : null;
  const noteLines = reviewReady && current ? reviewNotes(reviewData!.notes, reviewData!.chargeCodes, current.periodStart) : [];
  const worthCount = flagged.length;
  /** The grid on screen belongs to another row: the read for `current` is in flight (a failed read clears it). */
  const keptGrid = !!(grid && current && grid.periodId !== current.id);

  function decisionArea() {
    if (!current) return null;
    if (readError) {
      return (
        <Alert color="red" role="alert" data-testid="review-read-error">
          {readError}{' '}
          <Button size="compact-sm" variant="default" ml="xs" onClick={() => { headingRef.current?.focus(); void loadReview(current); }}>Retry</Button>
        </Alert>
      );
    }
    // A10: nothing to click until the review for THIS row is on screen.
    if (!(reviewData && reviewData.periodId === current.id)) {
      // Closing after a decision (reviewData cleared, L3): nothing at all, not "Loading…".
      return drawerOpen ? <Text role="status" size="sm" c="dimmed" data-testid="review-loading">Loading…</Text> : null;
    }
    const data = reviewData;
    const isOwn = current.userId === currentUserId;
    if (data.periodStatus !== 'submitted') {
      return data.approvalUiText ? <Text size="sm" data-testid="decision-text">{data.approvalUiText}</Text> : null;
    }
    // R2-7: supervisors and employees never decide their own period (the server enforces this too).
    if (isOwn && userRole !== 'admin') {
      return <Alert color="warning">You can&apos;t approve or return your own timesheet. Another admin or supervisor must review it.</Alert>;
    }
    // C2 (CO-D6/CO-D12): an admin's own timesheet once a second admin or a designated approver exists.
    if (isOwn && !data.canApprove) return <Alert color="warning">Your timesheet must be approved by another admin or your designated approver.</Alert>;
    if (!data.canApprove) return <Alert color="gray">You can view but not approve this timesheet.</Alert>;
    return (
      <Stack gap="sm">
        {isOwn && (
          <Alert color="signal">
            This is your own timesheet. You are the only active admin and have no designated approver, so you may decide
            it — the decision is visibly marked as a self-decision everywhere it appears.
          </Alert>
        )}
        <DecisionCard
          isOwnPeriod={isOwn}
          comment={comment}
          onCommentChange={(v) => { setComment(v); if (commentError && v.trim()) setCommentError(null); }}
          commentError={commentError}
          error={decisionError}
          busy={busy}
          onApprove={() => { void decide('approve'); }}
          onReturn={() => { void decide('return'); }}
          openNext={openNext}
          onOpenNextChange={setOpenNext}
          textareaRef={commentRef}
        />
      </Stack>
    );
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Timesheets waiting for you come first, oldest pay period first."
        notices={notices}
      />

      {/* Scope sentence (supervisors): the people they can approve, never counted twice (UX-2 ruling). */}
      {userRole === 'supervisor' && scopeInfo && scopeInfo.approvableEmployeeCount + scopeInfo.designatedByCount > 0 && (
        <Text size="sm" mb="md" data-testid="scope-sentence">{scopeSentence(scopeInfo)}.</Text>
      )}

      {/* Empty state for supervisors with nobody to review */}
      {userRole === 'supervisor' && scopeInfo && scopeInfo.approvableEmployeeCount + scopeInfo.designatedByCount === 0 && (
        <Paper withBorder p="xl" ta="center" radius="md" mb="md">
          <Text size="lg" c="dimmed" mb="sm">No employees in your scope</Text>
          {/* feature-plan-approval-scope.md §5: approval scope comes only from Assignments → Approval scope. */}
          <Text size="sm" c="dimmed" data-testid="scope-empty">
            {scopeInfo.assignedClinCount === 0
              ? "You don't approve any CLINs yet. An admin can add them on Assignments → Approval scope."
              : 'Nobody works on the CLINs you approve yet, and nobody has designated you as their approver, so there are no timesheets you can review.'}
          </Text>
        </Paper>
      )}

      <SegmentedControl
        mb="md"
        fullWidth={narrow}
        value={view}
        onChange={(v) => setView(v as ApprovalsView)}
        data={[
          { value: 'waiting', label: `Waiting for you (${waitingCount})` },
          { value: 'decided', label: 'Decided' },
          { value: 'everything', label: 'Everything' },
        ]}
        aria-label="Which timesheets to show"
      />

      <MantineReactTable table={table} />

      <Drawer.Root
        opened={drawerOpen}
        onClose={closeDrawer}
        onExitTransitionEnd={applyCloseFocus}
        returnFocus={false}
        closeOnEscape={!busy.any()}
        closeOnClickOutside={!busy.any()}
        position="right"
        size={phone ? '100%' : 'xl'}
      >
        <Drawer.Overlay />
        <Drawer.Content>
          <Drawer.Header>
            {/* The dialog's name, and the focus target when the focused button goes away (M2). */}
            <Drawer.Title ref={headingRef} tabIndex={-1} data-testid="review-heading">
              {current ? `${current.userName} · ${periodOf(current)}` : ''}
            </Drawer.Title>
            <Drawer.CloseButton aria-label="Close" />
          </Drawer.Header>
          <Drawer.Body>
            <VisuallyHidden role="status" aria-live="polite" data-testid="review-announcement">{announcement}</VisuallyHidden>
            {current && (
              <Stack gap="md">
                <Group justify="space-between" align="center" wrap="wrap" gap="xs">
                  <Group gap={6} data-testid="review-header">
                    <Text size="sm">Submitted {submittedDay(current.submittedAt)}</Text>
                    {totalHours !== null && <Text size="sm">· {formatHours(totalHours)} hours ·</Text>}
                    <StatusBadge status={current.status} />
                  </Group>
                  {navigable && (
                    <Group gap="xs" data-testid="review-nav">
                      <Text size="sm" c="dimmed">{navIndex + 1} of {waitingRows.length} waiting</Text>
                      <Button size="xs" variant="default" aria-label="Previous waiting timesheet"
                        aria-disabled={navIndex === 0 || busy.any() || undefined} data-disabled={navIndex === 0 || busy.any() || undefined}
                        onClick={() => step(-1)}>‹ Previous</Button>
                      <Button size="xs" variant="default" aria-label="Next waiting timesheet"
                        aria-disabled={navIndex === waitingRows.length - 1 || busy.any() || undefined} data-disabled={navIndex === waitingRows.length - 1 || busy.any() || undefined}
                        onClick={() => step(1)}>Next ›</Button>
                    </Group>
                  )}
                </Group>

                {/* The last loaded grid (Previous / Next keep it visible until the next one arrives), captioned as ITS
                    employee's — and, while kept, marked busy and dimmed with a visible line saying whose it is (M1). */}
                {grid && (
                  <div aria-busy={keptGrid || undefined} data-testid="review-grid">
                    {keptGrid && <Text size="sm" c="dimmed" data-testid="review-grid-kept">Showing {grid.employeeName} until this loads</Text>}
                    <ReviewGrid
                      chargeCodes={grid.data.chargeCodes}
                      entries={grid.data.entries}
                      start={grid.start}
                      numDays={grid.numDays}
                      flagged={grid.data.flagged ?? []}
                      notes={grid.data.notes ?? {}}
                      caption={`Hours for ${grid.employeeName}, ${grid.periodText}`}
                      dimmed={keptGrid}
                    />
                  </div>
                )}

                <div className={classes.cards}>
                  <Paper withBorder radius="md" p="md" data-testid="worth-a-look">
                    <Text component="h3" fw={600} size="sm" m={0} mb="xs">Worth a look{reviewReady ? ` (${worthCount})` : ''}</Text>
                    {reviewReady ? (
                      <Stack gap="xs">
                        {lastReturn && (
                          <Text size="sm" data-testid="last-return">
                            Returned {dayOf(lastReturn.at)} by {lastReturn.byName ?? 'an unknown user'}: “{lastReturn.comment ?? ''}”
                          </Text>
                        )}
                        {flagged.map((f) => (
                          <div key={`${f.rowId}-${f.dayIndex}`} data-testid="flagged-change">
                            <Text size="sm">
                              <b>{formatCalendarDate(addDays(current.periodStart, f.dayIndex), 'ddd MMM D')} · {rowName(f.rowId, reviewData!.chargeCodes)}</b>:{' '}
                              {f.kind === 'late'
                                ? `${formatHours(f.current.hours)}, entered ${dayOf(f.current.createdAt)}`
                                : `${f.previousHours === null ? '—' : formatHours(f.previousHours)} → ${formatHours(f.current.hours)}`}
                              {f.sinceReturned && <span className={classes.tag}>Since returned</span>}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {[reasonLabel(f.current.reasonCode), f.current.comment ? `“${f.current.comment}”` : null,
                                f.kind === 'correction' ? `changed ${dayOf(f.current.createdAt)}` : null,
                                f.originallyLate ? 'originally entered late' : null].filter(Boolean).join(' · ')}
                            </Text>
                          </div>
                        ))}
                        {reviewData!.submittedComment && <Text size="sm" data-testid="submit-note">Submit note: “{reviewData!.submittedComment}”</Text>}
                        {flagged.length === 0 && !lastReturn && <Text size="sm" c="dimmed">Nothing unusual in this timesheet.</Text>}
                      </Stack>
                    ) : null}
                  </Paper>

                  <Paper withBorder radius="md" p="md">
                    <Text component="h3" fw={600} size="sm" m={0} mb="xs" id="review-notes-heading">Notes{reviewReady ? ` (${noteLines.length})` : ''}</Text>
                    {noteLines.length > 0 ? (
                      <List size="sm" spacing={4} aria-labelledby="review-notes-heading" data-testid="review-notes">
                        {noteLines.map((n) => <List.Item key={n.key}>{n.text}</List.Item>)}
                      </List>
                    ) : reviewReady ? <Text size="sm" c="dimmed">No notes.</Text> : null}
                  </Paper>

                  <div data-testid="decision-area">{decisionArea()}</div>
                </div>
              </Stack>
            )}
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
    </>
  );
}
