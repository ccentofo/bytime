'use client';

import { ActionIcon, Group, Text, Title, Select, Button } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconCalendarEvent } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { getNumDaysInPeriod, getLastWeekdayInPeriod, navigatePeriod, getCurrentPeriodStart } from '@/lib/date-utils';
import { useMemo } from 'react';

// Generate period options for the dropdown (current + 23 previous = 24 total, ~12 months)
function generatePeriodOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  let periodStart = getCurrentPeriodStart();

  for (let i = 0; i < 24; i++) {
    const start = dayjs(periodStart);
    const lastWeekday = getLastWeekdayInPeriod(periodStart);
    const numDays = getNumDaysInPeriod(periodStart);
    const end = start.add(numDays - 1, 'day');

    options.push({
      value: start.format('YYYY-MM-DD'),
      label: `Ending ${dayjs(lastWeekday).format('MMM D, YYYY')}`,
    });
    periodStart = navigatePeriod(periodStart, 'prev');
  }

  return options;
}

export function PayPeriodSelector() {
  const { state, loadPeriod, loadPeriodByDate } = useTimesheet();
  const { periodStart } = state;

  const start = dayjs(periodStart);
  const numDays = getNumDaysInPeriod(periodStart);
  const end = start.add(numDays - 1, 'day');
  const periodLabel = `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;

  const periodOptions = useMemo(() => generatePeriodOptions(), []);
  const currentPeriodStart = useMemo(() => getCurrentPeriodStart(), []);
  const isCurrentPeriod = dayjs(periodStart).isSame(dayjs(currentPeriodStart), 'day');

  const selectedValue = dayjs(periodStart).format('YYYY-MM-DD');

  function handlePeriodSelect(value: string | null) {
    if (!value) return;
    const newStart = dayjs(value).startOf('day').toDate();
    if (!dayjs(newStart).isSame(dayjs(periodStart), 'day')) {
      loadPeriodByDate(newStart);
    }
  }

  function handleCurrentClick() {
    if (!isCurrentPeriod) {
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
          disabled={state.isLoadingPeriod}
        >
          <IconChevronLeft size={20} />
        </ActionIcon>
        <div>
          <Title order={3}>Semi-Monthly Timesheet</Title>
          <Text c="dimmed" size="sm">
            Pay Period: {periodLabel}
          </Text>
        </div>
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={() => loadPeriod('next')}
          aria-label="Next pay period"
          disabled={state.isLoadingPeriod}
        >
          <IconChevronRight size={20} />
        </ActionIcon>
      </Group>

      <Group gap="sm">
        <Select
          placeholder="Jump to period..."
          data={periodOptions}
          value={selectedValue}
          onChange={handlePeriodSelect}
          searchable
          size="sm"
          style={{ width: 220 }}
          disabled={state.isLoadingPeriod}
        />
        <Button
          variant="light"
          size="sm"
          leftSection={<IconCalendarEvent size={16} />}
          onClick={handleCurrentClick}
          disabled={isCurrentPeriod || state.isLoadingPeriod}
        >
          Current
        </Button>
      </Group>
    </Group>
  );
}
