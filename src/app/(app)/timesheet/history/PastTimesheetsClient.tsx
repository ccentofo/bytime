'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Anchor, Badge, Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { getPastTimesheets } from '@/server/actions/timesheet';
import { calendarDayOf, formatCalendarDate } from '@/lib/calendar-date';
import { PERIOD_STATUS_COLOR } from '@/lib/ui/status-colors';
import type { PastPeriodRow, PastPeriodStatus, PastPeriodsPage } from '@/server/internal/past-periods';

type Props = {
  initial: PastPeriodsPage;
  timeZone: string;
};

/** feature-plan-ux-timesheet-ui.md §4.11: the status word (never color alone) and its color. */
export const PAST_STATUS: Record<PastPeriodStatus, { word: string; color: string }> = {
  notSubmitted: { word: 'Not submitted', color: PERIOD_STATUS_COLOR.draft },
  submitted: { word: 'Submitted', color: PERIOD_STATUS_COLOR.submitted },
  approved: { word: 'Approved', color: PERIOD_STATUS_COLOR.approved },
  rejected: { word: 'Returned', color: PERIOD_STATUS_COLOR.rejected },
};

/** Every row opens its own period — the current one too, so the link still works after a new period starts (L12). */
export const pastPeriodHref = (row: Pick<PastPeriodRow, 'start'>) => `/timesheet?period=${row.start}`;

/** Append a page, keeping the first copy of each period (a period can shift pages when a new one starts). */
export function mergePastRows(rows: PastPeriodRow[], more: PastPeriodRow[]): PastPeriodRow[] {
  const seen = new Set(rows.map((r) => r.start));
  const out = [...rows];
  for (const r of more) {
    if (seen.has(r.start)) continue;
    seen.add(r.start);
    out.push(r);
  }
  return out;
}

/**
 * Past timesheets (feature-plan-ux-timesheet-ui.md §4.11, UX3-Q1): every period since the account started, newest
 * first, including periods never submitted. No pagination, search or sorting — "Load more" appends the next page.
 */
export function PastTimesheetsClient({ initial, timeZone }: Props) {
  const [rows, setRows] = useState(initial.rows);
  const [page, setPage] = useState(initial.page);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  // "(current)" comes only from the latest response (L12).
  const [currentStart, setCurrentStart] = useState(initial.currentStart);
  const [isPending, startTransition] = useTransition();
  const tableRef = useRef<HTMLDivElement>(null);

  const columns = useMemo<MRT_ColumnDef<PastPeriodRow>[]>(() => {
    const day = (d: Date | null) => (d ? formatCalendarDate(calendarDayOf(new Date(d), timeZone), 'MMM D, YYYY') : '');
    return [
      {
        id: 'period',
        header: 'Period',
        accessorKey: 'label',
        Cell: ({ row }) => (
          <Anchor component={Link} href={pastPeriodHref(row.original)} data-start={row.original.start}>
            {row.original.label}{row.original.start === currentStart ? ' (current)' : ''}
          </Anchor>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        Cell: ({ row }) => (
          <Group gap={6} wrap="wrap">
            <Badge color={PAST_STATUS[row.original.status].color} variant="light">{PAST_STATUS[row.original.status].word}</Badge>
            {row.original.approvalBadge && <Badge color="gray" variant="light">{row.original.approvalBadge}</Badge>}
          </Group>
        ),
      },
      { id: 'hours', header: 'Hours', accessorFn: (r) => r.hours.toFixed(2) },
      { id: 'submitted', header: 'Submitted', accessorFn: (r) => day(r.submittedAt) },
      { id: 'reviewed', header: 'Reviewed', accessorFn: (r) => day(r.reviewedAt) },
      { id: 'comment', header: 'Comment', accessorFn: (r) => r.reviewComment ?? '' },
    ];
  }, [timeZone, currentStart]);

  const table = useAppTable<PastPeriodRow>({
    columns,
    data: rows,
    getRowId: (r) => r.start,
    enablePagination: false,
    enableGlobalFilter: false,
    enableSorting: false,
    enableTopToolbar: false,
    enableBottomToolbar: false,
    mantineTableProps: { 'aria-label': 'Past timesheets' }, // L14
    localization: { noRecordsToDisplay: 'No past timesheets yet.' },
  });

  function loadMore() {
    if (isPending) return;
    startTransition(async () => {
      try {
        const next = await getPastTimesheets({ page: page + 1 });
        // L12: a new period started since page 0 was fetched — refresh page 0 (the new current row on top; the rows it
        // shares with what's shown take its latest data). The next page has shifted by the same amount; de-dup covers it.
        let shown = rows;
        if (next.currentStart !== currentStart) {
          const top = await getPastTimesheets({ page: 0 });
          const fresh = new Map(top.rows.map((r) => [r.start, r]));
          shown = mergePastRows(top.rows, rows.map((r) => fresh.get(r.start) ?? r));
        }
        const merged = mergePastRows(shown, next.rows);
        const firstNew = next.rows.find((r) => !shown.some((x) => x.start === r.start));
        setRows(merged);
        setPage(next.page);
        setHasMore(next.hasMore);
        setCurrentStart(next.currentStart);
        // The button goes away with the last page: focus moves to the first new row — or, when the page brought nothing
        // new, to the last row (L11) — instead of the page body.
        const focusStart = firstNew?.start ?? merged.at(-1)?.start;
        if (!next.hasMore && focusStart) {
          requestAnimationFrame(() => tableRef.current?.querySelector<HTMLElement>(`a[data-start="${focusStart}"]`)?.focus());
        }
      } catch {
        notifications.show({ title: "Couldn't load more timesheets", message: 'Try again.', color: 'red', icon: <Icons.statusError size={ICON_SIZE.button} /> });
      }
    });
  }

  return (
    <>
      <PageHeader title="Past timesheets" />
      <div ref={tableRef}>
        <MantineReactTable table={table} />
      </div>
      {hasMore && (
        <Group justify="center" mt="md">
          {/* aria-disabled while loading (never `disabled`, which drops focus; Mantine's `loading` sets it). */}
          <Button variant="default" onClick={loadMore} aria-disabled={isPending || undefined}>{isPending ? 'Loading…' : 'Load more'}</Button>
        </Group>
      )}
    </>
  );
}
