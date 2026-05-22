'use client';

import { ActionIcon, Group, Text, Title } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { getNumDaysInPeriod } from '@/data/mock-timesheet';

export function PayPeriodSelector() {
  const { state, dispatch } = useTimesheet();
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
          onClick={() => dispatch({ type: 'NAVIGATE_PERIOD', direction: 'prev' })}
          aria-label="Previous pay period"
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
          onClick={() => dispatch({ type: 'NAVIGATE_PERIOD', direction: 'next' })}
          aria-label="Next pay period"
        >
          <IconChevronRight size={20} />
        </ActionIcon>
      </Group>
    </Group>
  );
}
