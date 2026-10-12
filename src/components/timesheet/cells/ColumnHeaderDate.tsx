'use client';

import { Stack, Text, Badge, Tooltip } from '@mantine/core';
import dayjs from 'dayjs';
import type { Density } from '../BiWeeklyTable';

interface ColumnHeaderDateProps {
  date: Date;
  dayIndex: number;
  hasMissingHours?: boolean;
  density?: Density;
}

// Single weekday initial: Mon→M, Tue→T, Wed→W, Thu→R, Fri→F, Sat→S, Sun→U
const WEEKDAY_INITIAL = ['U', 'M', 'T', 'W', 'R', 'F', 'S'];

export function ColumnHeaderDate({
  date,
  dayIndex: _dayIndex,
  hasMissingHours,
  density = 'comfortable',
}: ColumnHeaderDateProps) {
  const d = dayjs(date);
  const isWeekend = d.day() === 0 || d.day() === 6;
  const isPast = d.isBefore(dayjs(), 'day');
  const isToday = d.isSame(dayjs(), 'day');

  if (density === 'dense') {
    // Dense: weekday initial + day number; Late is a small orange dot with tooltip
    const initial = WEEKDAY_INITIAL[d.day()];
    return (
      <Stack align="center" gap={1} style={{ lineHeight: 1.1 }}>
        <Text
          fw={isToday ? 900 : 600}
          size="xs"
          c={isToday ? 'signal' : isWeekend ? 'dimmed' : undefined}
          td={isToday ? 'underline' : undefined}
          style={{ fontSize: 10 }}
        >
          {initial}
        </Text>
        <Text
          size="xs"
          c={isToday ? 'signal' : 'dimmed'}
          style={{ fontSize: 10 }}
        >
          {d.date()}
        </Text>
        {hasMissingHours && (
          <Tooltip label="Late entry — no hours logged" withArrow position="top">
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: 'var(--mantine-color-warning-6)',
                marginTop: 1,
              }}
              aria-label="Late entry"
            />
          </Tooltip>
        )}
      </Stack>
    );
  }

  // Comfortable / compact
  const fontSize = density === 'compact' ? 11 : undefined;
  return (
    <Stack align="center" gap={0}>
      <Text
        fw={isToday ? 900 : 700}
        size="sm"
        c={isToday ? 'signal' : isWeekend ? 'dimmed' : undefined}
        td={isToday ? 'underline' : undefined}
        style={fontSize ? { fontSize } : undefined}
      >
        {d.format('ddd')}
      </Text>
      <Text
        size="xs"
        c={isToday ? 'signal' : 'dimmed'}
        fs={isPast && !isToday ? 'italic' : undefined}
        style={fontSize ? { fontSize } : undefined}
      >
        {d.format('MMM D')}
      </Text>
      {hasMissingHours && (
        <Badge size="xs" color="warning" variant="light">
          Late
        </Badge>
      )}
    </Stack>
  );
}
