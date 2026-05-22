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

  return (
    <Stack align="center" gap={0}>
      <Text fw={700} size="sm" c={isWeekend ? 'dimmed' : undefined}>
        {d.format('ddd')}
      </Text>
      <Text size="xs" c="dimmed">
        {d.format('MMM D')}
      </Text>
    </Stack>
  );
}
