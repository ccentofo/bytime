'use client';

import { useMemo } from 'react';
import { addDays, dayOfWeek, formatCalendarDate, isAfter, type CalendarDate } from '@/lib/calendar-date';
import { dailyTotalsOf, periodProgress, type PeriodProgress } from '@/lib/timesheet/period-progress';
import { weeklyTotals } from '@/lib/timesheet/weekly';
import type { TimesheetState } from '@/types/timesheet';

export interface SubmitChecks {
  /** Shown in SubmitModal and appended to the submission comment (unchanged rules). */
  completenessWarnings: string[];
  /** SubmitModal's exempt figure: Σ over EVERY week touching the period of max(0, known week total − 40) — today's meaning. */
  uncompensatedHours: number;
  totalPeriodHours: number;
  progress: PeriodProgress;
  /** 'YYYY-MM-DD' → day total across rows (working values, unsaved edits included). */
  dailyHours: Record<string, number>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Submit-time checks (feature-plan-ux-timesheet-ui.md §4.1), moved out of the old toolbar: completeness warnings exactly as
 * before; the overtime figure now uses the workspace workweek (weeklyTotals), still counting incomplete weeks.
 */
export function useSubmitChecks(state: Pick<TimesheetState, 'periodStart' | 'numDays' | 'entries' | 'today' | 'submitOpensOn' | 'workweekStartDay' | 'outsideWeekHours'>): SubmitChecks {
  const { periodStart, numDays, entries, today, submitOpensOn, workweekStartDay, outsideWeekHours } = state;
  return useMemo(() => {
    const dailyHours = dailyTotalsOf(periodStart, numDays, entries);
    const progress = periodProgress({ start: periodStart, numDays, dailyHours, today, submitOpensOn });
    const days = Array.from({ length: numDays }, (_, i) => addDays(periodStart, i));
    const weeks = weeklyTotals(days, dailyHours, outsideWeekHours, workweekStartDay, today);
    const uncompensatedHours = round2(weeks.reduce((s, w) => s + Math.max(0, w.total - 40), 0));
    return { completenessWarnings: completenessWarnings(periodStart, numDays, dailyHours, today), uncompensatedHours, totalPeriodHours: progress.total, progress, dailyHours };
  }, [periodStart, numDays, entries, today, submitOpensOn, workweekStartDay, outsideWeekHours]);
}

/** The period completeness warnings (unchanged from the old toolbar). */
export function completenessWarnings(periodStart: CalendarDate, numDays: number, dailyHours: Record<string, number>, today: CalendarDate): string[] {
  const warnings: string[] = [];
  if (numDays === 0) return warnings;
  const dailyTotals = Array.from({ length: numDays }, (_, i) => dailyHours[addDays(periodStart, i)] ?? 0);

  // Missing workdays (weekdays with 0 hours). "Past or today" uses the server's today — never the browser's clock.
  const missingDays: string[] = [];
  for (let i = 0; i < numDays; i++) {
    const date = addDays(periodStart, i);
    const dow = dayOfWeek(date);
    if (dow >= 1 && dow <= 5 && !isAfter(date, today) && dailyTotals[i] === 0) missingDays.push(formatCalendarDate(date, 'ddd MMM D'));
  }
  if (missingDays.length > 0) {
    warnings.push(`${missingDays.length} workday${missingDays.length !== 1 ? 's' : ''} with no hours recorded: ${missingDays.join(', ')}`);
  }

  // Excessive hours on a single day (> 16 hours).
  for (let i = 0; i < numDays; i++) {
    if (dailyTotals[i] > 16) {
      warnings.push(`${dailyTotals[i].toFixed(2)} hours recorded on ${formatCalendarDate(addDays(periodStart, i), 'ddd MMM D')} — please verify this is correct`);
    }
  }

  // Very low total hours (less than 50% of expected workdays × 8).
  const totalHours = dailyTotals.reduce((sum, h) => sum + h, 0);
  const workdayCount = Array.from({ length: numDays }, (_, i) => {
    const dow = dayOfWeek(addDays(periodStart, i));
    return dow >= 1 && dow <= 5 ? 1 : 0;
  }).reduce((a: number, b: number) => a + b, 0);
  const expectedMinHours = workdayCount * 4;
  if (totalHours > 0 && totalHours < expectedMinHours) {
    warnings.push(`Total period hours (${totalHours.toFixed(2)}) seem low for ${workdayCount} workdays. Ensure all time is accounted for.`);
  }
  return warnings;
}
