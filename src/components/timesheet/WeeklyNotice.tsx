'use client';

import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { addDays, formatCalendarDate } from '@/lib/calendar-date';
import { weeklyTotals } from '@/lib/timesheet/weekly';
import styles from './Timesheet.module.css';

/**
 * The weekly notice (feature-plan-ux-timesheet-ui.md §4.1 item 4, UX3B-D3): FLSA-exempt employees only, built from
 * COMPLETE workspace weeks — "Week of {MMM D}: {h} hours. Record all time worked, including leave." under 40, and
 * "Week of {MMM D}: {o} hours over 40 (uncompensated)." over. Replaces the old exempt panel. One slim line (§14.5): a
 * static note, not a Mantine Alert.
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
    <p role="note" data-testid="weekly-notice" className={styles.weeklyNotice}>
      <Icons.statusInfo size={ICON_SIZE.button} aria-hidden="true" />
      <span>{lines.join(' · ')}</span>
    </p>
  );
}
