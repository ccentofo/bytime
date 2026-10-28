'use client';

import { useEffect, useState } from 'react';
import { ActionIcon, Group, Text, Title, Select, Button } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconCalendarEvent } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { addDays, formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { getPeriodOptions, type PeriodOption } from '@/server/actions/periods';

const PERIOD_TYPE_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Bi-Weekly',
  semimonthly: 'Semi-Monthly',
  monthly: 'Monthly',
};

export function PayPeriodSelector() {
  const { state, loadPeriod, loadPeriodByDate } = useTimesheet();
  const { periodStart, periodConfig: config, today, numDays } = state;
  // No navigation while a period is loading or a save is in flight.
  const navBusy = state.isLoadingPeriod || state.isSaving;
  const end = addDays(periodStart, numDays - 1);
  const periodLabel = `${formatCalendarDate(periodStart, 'MMM D')} – ${formatCalendarDate(end, 'MMM D, YYYY')}`;

  // D4: period options and "what is the current period" come from the server
  // (getPeriodOptions) — the client does no schedule math of its own, so the dropdown's
  // history stays correct across a pay-schedule change instead of assuming one schedule
  // applied to every past period.
  const [periodOptions, setPeriodOptions] = useState<PeriodOption[]>([]);
  const [currentPeriodStart, setCurrentPeriodStart] = useState<CalendarDate | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPeriodOptions(today, 23, 0)
      .then((options) => {
        if (cancelled) return;
        setPeriodOptions(options);
        setCurrentPeriodStart(options[options.length - 1]?.start ?? null);
      })
      .catch(() => {
        if (!cancelled) setPeriodOptions([]); // the arrows still work; the list just stays empty
      });
    return () => {
      cancelled = true;
    };
  }, [today]);

  const isCurrentPeriod = currentPeriodStart !== null && periodStart === currentPeriodStart;
  const periodTypeLabel = PERIOD_TYPE_LABELS[config.periodType] ?? 'Semi-Monthly';

  function handlePeriodSelect(value: string | null) {
    if (!value) return;
    if (value !== periodStart) {
      loadPeriodByDate(value as CalendarDate);
    }
  }

  function handleCurrentClick() {
    if (currentPeriodStart && !isCurrentPeriod) {
      loadPeriodByDate(currentPeriodStart);
    }
  }

  return (
    <Group justify="space-between" align="center" mb="md" wrap="wrap">
      <Group gap="sm" align="center">
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={() => loadPeriod('prev')}
          aria-label="Previous pay period"
          disabled={navBusy}
        >
          <IconChevronLeft size={20} />
        </ActionIcon>
        <div>
          <Title order={1} size="h3">{periodTypeLabel} Timesheet</Title>
          <Text c="dimmed" size="sm">
            Pay Period: {periodLabel}
          </Text>
        </div>
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={() => loadPeriod('next')}
          aria-label="Next pay period"
          // UX-3 A4.9: never past the current period (a same-period reload would drop unsaved edits).
          disabled={navBusy || state.isCurrent || isCurrentPeriod}
        >
          <IconChevronRight size={20} />
        </ActionIcon>
      </Group>

      <Group gap="sm">
        <Select
          placeholder="Jump to period..."
          data={periodOptions.map((o) => ({ value: o.start, label: o.label }))}
          value={periodStart}
          onChange={handlePeriodSelect}
          searchable
          size="sm"
          style={{ width: 220 }}
          disabled={navBusy}
        />
        <Button
          variant="light"
          size="sm"
          leftSection={<IconCalendarEvent size={16} />}
          onClick={handleCurrentClick}
          disabled={isCurrentPeriod || currentPeriodStart === null || navBusy}
        >
          Current
        </Button>
      </Group>
    </Group>
  );
}
