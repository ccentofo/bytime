'use client';

import { Text } from '@mantine/core';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';

interface TotalHoursCellProps {
  chargeCodeId: string;
}

export function TotalHoursCell({ chargeCodeId }: TotalHoursCellProps) {
  const { state } = useTimesheet();

  const entry = state.entries.find((e) => e.chargeCodeId === chargeCodeId);
  const total = entry ? entry.hours.reduce((a, b) => a + b, 0) : 0;

  return (
    <Text fw={700} ta="center" size="sm">
      {total.toFixed(2)}
    </Text>
  );
}
