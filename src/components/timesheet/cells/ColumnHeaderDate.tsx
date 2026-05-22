'use client';

import { Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';

interface ColumnHeaderDateProps {
  date: Date;
  dayIndex: number; // kept for potential future use
}

export function ColumnHeaderDate({ date, dayIndex: _dayIndex }: ColumnHeaderDateProps) {
  const d = dayjs(date);
  const isWeekend = d.day() === 0 || d.day() === 6;
  const isPast = d.isBefore(dayjs(), 'day');
  const isToday = d.isSame(dayjs(), 'day');

  return (
    <Stack align="center" gap={0}>
      <Text
        fw={isToday ? 900 : 700}
        size="sm"
        c={isToday ? 'blue' : isWeekend ? 'dimmed' : undefined}
        td={isToday ? 'underline' : undefined}
      >
        {d.format('ddd')}
      </Text>
      <Text
        size="xs"
        c={isToday ? 'blue' : 'dimmed'}
        fs={isPast && !isToday ? 'italic' : undefined}
      >
        {d.format('MMM D')}
      </Text>
    </Stack>
  );
}
