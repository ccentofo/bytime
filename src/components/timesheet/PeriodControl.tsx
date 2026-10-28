'use client';

import { useEffect, useId, useState } from 'react';
import { ActionIcon, Button, Group, Select, Text } from '@mantine/core';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { useTimesheetActions, useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { periodLabel } from '@/lib/timesheet/labels';
import { getPeriodOptions, type PeriodOption } from '@/server/actions/periods';
import type { CalendarDate } from '@/lib/calendar-date';
import styles from './Timesheet.module.css';

/**
 * The period control (feature-plan-ux-timesheet-ui.md §4.1), under the "Timesheet" heading: ‹ / label / ›, "Choose
 * period" and "Today". Unavailable controls get aria-disabled plus a click guard — never `disabled` — so a focused
 * control never drops focus (trap T-P). "Current" follows the period list (re-fetched when today changes), with the
 * server's isCurrent until the list arrives (Part A). Every change goes through `go`, which the unsaved guard wraps.
 */
export function PeriodControl({ go }: { go: (change: () => Promise<void>) => Promise<void> }) {
  const { state } = useTimesheetState();
  const { loadPeriod, loadPeriodByDate } = useTimesheetActions();
  const id = useId();
  const { periodStart, periodEnd, today } = state;

  const [options, setOptions] = useState<PeriodOption[]>([]);
  const [currentStart, setCurrentStart] = useState<CalendarDate | null>(null);
  useEffect(() => {
    let cancelled = false;
    getPeriodOptions(today, 23, 0)
      .then((list) => {
        if (cancelled) return;
        setOptions(list);
        setCurrentStart(list[list.length - 1]?.start ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setOptions([]);
        setCurrentStart(null); // fall back to the server's isCurrent
      });
    return () => { cancelled = true; };
  }, [today]);

  const isCurrent = currentStart !== null ? periodStart === currentStart : state.isCurrent;
  const label = periodLabel(periodStart, periodEnd);
  // An older period opened from Past timesheets isn't in the 24-period list: it's added at the top.
  const data = [
    ...(options.some((o) => o.start === periodStart) ? [] : [{ value: periodStart, label }]),
    ...[...options].reverse().map((o) => ({ value: o.start, label: o.label })),
  ];

  return (
    <Group gap="xs" align="center" wrap="wrap" className={styles.periodControl}>
      <ActionIcon variant="subtle" size="lg" aria-label="Previous period" onClick={() => go(() => loadPeriod('prev'))}>
        <Icons.prevPeriod size={ICON_SIZE.nav} />
      </ActionIcon>
      <Text fw={600} className={styles.periodLabel}>{label}</Text>
      <ActionIcon
        variant="subtle"
        size="lg"
        aria-label="Next period"
        aria-disabled={isCurrent ? 'true' : undefined}
        aria-describedby={isCurrent ? `${id}-next-why` : undefined}
        data-disabled={isCurrent || undefined}
        onClick={() => { if (!isCurrent) void go(() => loadPeriod('next')); }}
      >
        <Icons.nextPeriod size={ICON_SIZE.nav} />
      </ActionIcon>
      {isCurrent && <span id={`${id}-next-why`} hidden>This is the current period</span>}
      <Select
        aria-label="Choose period"
        size="sm"
        data={data}
        value={periodStart}
        allowDeselect={false}
        onChange={(value) => { if (value && value !== periodStart) void go(() => loadPeriodByDate(value as CalendarDate)); }}
        className={styles.periodSelect}
      />
      <Button
        variant="light"
        size="sm"
        leftSection={<Icons.today size={ICON_SIZE.button} />}
        aria-disabled={isCurrent ? 'true' : undefined}
        aria-describedby={isCurrent ? `${id}-today-why` : undefined}
        data-disabled={isCurrent || undefined}
        onClick={() => { if (!isCurrent) void go(() => (currentStart ? loadPeriodByDate(currentStart) : loadPeriodByDate(today))); }}
      >
        Today
      </Button>
      {isCurrent && <span id={`${id}-today-why`} hidden>You&apos;re on the current period</span>}
    </Group>
  );
}
