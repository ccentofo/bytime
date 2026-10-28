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
import type { PastPeriodRow, PastPeriodStatus } from '@/server/internal/past-periods';

type PastPage = { rows: PastPeriodRow[]; page: number; hasMore: boolean };

type Props = {
  initial: PastPage;
  timeZone: string;
};

/** feature-plan-ux-timesheet-ui.md §4.11: the status word (never color alone) and its color. */
export const PAST_STATUS: Record<PastPeriodStatus, { word: string; color: string }> = {
  notSubmitted: { word: 'Not submitted', color: PERIOD_STATUS_COLOR.draft },
  submitted: { word: 'Submitted', color: PERIOD_STATUS_COLOR.submitted },
  approved: { word: 'Approved', color: PERIOD_STATUS_COLOR.approved },
  rejected: { word: 'Returned', color: PERIOD_STATUS_COLOR.rejected },
};

/** The current period opens at /timesheet; any other at /timesheet?period={start}. */
export const pastPeriodHref = (row: Pick<PastPeriodRow, 'start' | 'isCurrent'>) => (row.isCurrent ? '/timesheet' : `/timesheet?period=${row.start}`);

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
            {row.original.label}{row.original.isCurrent ? ' (current)' : ''}
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
  }, [timeZone]);

  const table = useAppTable<PastPeriodRow>({
    columns,
    data: rows,
    getRowId: (r) => r.start,
    enablePagination: false,
    enableGlobalFilter: false,
    enableSorting: false,
    enableTopToolbar: false,
    enableBottomToolbar: false,
    localization: { noRecordsToDisplay: 'No past timesheets yet.' },
  });

  function loadMore() {
    if (isPending) return;
    startTransition(async () => {
      try {
        const next = await getPastTimesheets({ page: page + 1 });
        const firstNew = next.rows.find((r) => !rows.some((x) => x.start === r.start));
        setRows((prev) => mergePastRows(prev, next.rows));
        setPage(next.page);
        setHasMore(next.hasMore);
        // The button goes away with the last page: focus moves to the first new row instead of the page body.
        if (!next.hasMore && firstNew) {
          requestAnimationFrame(() => tableRef.current?.querySelector<HTMLElement>(`a[data-start="${firstNew.start}"]`)?.focus());
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
