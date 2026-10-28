'use client';

import { Alert, Stack, Text } from '@mantine/core';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { addDays, formatCalendarDate } from '@/lib/calendar-date';
import { weeklyTotals } from '@/lib/timesheet/weekly';

/**
 * The weekly notice (feature-plan-ux-timesheet-ui.md §4.1 item 4, UX3B-D3): FLSA-exempt employees only, built from
 * COMPLETE workspace weeks — "Week of {MMM D}: {h} hours. Record all time worked, including leave." under 40, and
 * "Week of {MMM D}: {o} hours over 40 (uncompensated)." over. Replaces the old exempt panel.
 */
export function WeeklyNotice() {
  const { state, checks } = useTimesheetState();
  if (!state.flsaExempt) return null;
  const days = Array.from({ length: state.numDays }, (_, i) => addDays(state.periodStart, i));
  const weeks = weeklyTotals(days, checks.dailyHours, state.outsideWeekHours, state.workweekStartDay, state.today).filter((w) => w.complete);
  const lines = weeks.flatMap((w) => {
    const label = `Week of ${formatCalendarDate(w.weekStart, 'MMM D')}`;
    if (w.total < 40) return [`${label}: ${Number(w.total.toFixed(2))} hours. Record all time worked, including leave.`];
    if (w.overtime > 0) return [`${label}: ${Number(w.overtime.toFixed(2))} hours over 40 (uncompensated).`];
    return [];
  });
  if (lines.length === 0) return null;
  return (
    <Alert color="signal" variant="light" icon={<Icons.statusInfo size={ICON_SIZE.button} />} data-testid="weekly-notice">
      <Stack gap={2}>{lines.map((l) => <Text key={l} size="sm">{l}</Text>)}</Stack>
    </Alert>
  );
}
