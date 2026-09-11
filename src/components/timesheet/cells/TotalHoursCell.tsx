'use client';

import { Text } from '@mantine/core';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import type { Density } from '../BiWeeklyTable';

interface TotalHoursCellProps {
  chargeCodeId: string;
  density?: Density;
}

function formatTotal(value: number, density: Density): string {
  if (density === 'dense') {
    if (value === Math.floor(value)) return String(Math.floor(value));
    return value % 0.5 === 0 ? value.toFixed(1) : value.toFixed(2);
  }
  return value.toFixed(2);
}

export function TotalHoursCell({ chargeCodeId, density = 'comfortable' }: TotalHoursCellProps) {
  const { state } = useTimesheet();
  const entry = state.entries.find((e) => e.chargeCodeId === chargeCodeId);
  const total = entry ? (entry.hours ?? []).reduce((a, b) => a + (b ?? 0), 0) : 0;

  return (
    <Text
      fw={700}
      ta="center"
      size={density === 'dense' ? 'xs' : 'sm'}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {formatTotal(total, density)}
    </Text>
  );
}
