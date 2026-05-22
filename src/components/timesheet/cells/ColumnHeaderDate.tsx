'use client';

import { Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';

interface ColumnHeaderDateProps {
  date: Date;
  dayIndex: number;
}

// Weekend day indices (assuming Monday start): 5=Sat, 6=Sun, 12=Sat, 13=Sun
const WEEKEND_INDICES = new Set([5, 6, 12, 13]);

export function ColumnHeaderDate({ date, dayIndex }: ColumnHeaderDateProps) {
  const d = dayjs(date);
  const isWeekend = WEEKEND_INDICES.has(dayIndex);

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
