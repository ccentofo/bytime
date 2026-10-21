'use client';

import { Stack, Text, Badge, Tooltip } from '@mantine/core';
import { dayOfWeek, formatCalendarDate, isBefore, type CalendarDate } from '@/lib/calendar-date';
import type { Density } from '../BiWeeklyTable';

interface ColumnHeaderDateProps {
  date: CalendarDate;
  today: CalendarDate;
  dayIndex: number;
  hasMissingHours?: boolean;
  density?: Density;
}

// Single weekday initial: Mon→M, Tue→T, Wed→W, Thu→R, Fri→F, Sat→S, Sun→U
const WEEKDAY_INITIAL = ['U', 'M', 'T', 'W', 'R', 'F', 'S'];

export function ColumnHeaderDate({
  date,
  today,
  hasMissingHours,
  density = 'comfortable',
}: ColumnHeaderDateProps) {
  const dow = dayOfWeek(date);
  const isWeekend = dow === 0 || dow === 6;
  const isToday = date === today;
  const isPast = !isToday && isBefore(date, today);

  if (density === 'dense') {
    // Dense: weekday initial + day number; Late is a small orange dot with tooltip
    const initial = WEEKDAY_INITIAL[dow];
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
          {formatCalendarDate(date, 'D')}
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
        {formatCalendarDate(date, 'ddd')}
      </Text>
      <Text
        size="xs"
        c={isToday ? 'signal' : 'dimmed'}
        fs={isPast ? 'italic' : undefined}
        style={fontSize ? { fontSize } : undefined}
      >
        {formatCalendarDate(date, 'MMM D')}
      </Text>
      {hasMissingHours && (
        <Badge size="xs" color="warning" variant="light">
          Late
        </Badge>
      )}
    </Stack>
  );
}
