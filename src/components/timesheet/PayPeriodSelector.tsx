'use client';

import { ActionIcon, Group, Text, Title } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { getNumDaysInPeriod } from '@/lib/date-utils';

export function PayPeriodSelector() {
  const { state, loadPeriod } = useTimesheet();
  const { periodStart } = state;

  const start = dayjs(periodStart);
  const numDays = getNumDaysInPeriod(periodStart);
  const end = start.add(numDays - 1, 'day');
  const periodLabel = `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;

  return (
    <Group justify="flex-end" align="center" mb="md">
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
    </Group>
  );
}
