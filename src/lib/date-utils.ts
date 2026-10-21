import {
  type CalendarDate,
  addDays,
  addMonths,
  dayOfMonth,
  dayOfWeek,
  daysInMonth,
  diffDays,
  startOfMonth,
  withDayOfMonth,
} from '@/lib/calendar-date';

// ---------------------------------------------------------------------------
// Period Configuration Types
//
// feature-plan-calendar-dates.md D1: `config` is now REQUIRED on every function below (no
// semimonthly default) — every caller must pass the tenant's actual effective config. This is
// deliberate: it turns every call site that used to silently assume semimonthly into a compile
// error, which is how §0.6's 13 hard-coded-schedule bugs get found instead of re-investigated.
// ---------------------------------------------------------------------------

export type PeriodType = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface PeriodConfig {
  periodType: PeriodType;
  anchorDate: CalendarDate;
  weekStartDay: number; // 0=Sun, 1=Mon
}

// Used only where there is genuinely no config row yet (getEffectiveConfigAt's fallback) — never
// as a function parameter default.
export const DEFAULT_PERIOD_CONFIG: PeriodConfig = {
  periodType: 'semimonthly',
  anchorDate: '2026-01-01' as CalendarDate,
  weekStartDay: 1,
};

// ---------------------------------------------------------------------------
// Core Period Utilities
// ---------------------------------------------------------------------------

/** Returns the number of days in the pay period that starts on `periodStart`. */
export function getNumDaysInPeriod(periodStart: CalendarDate, config: PeriodConfig): number {
  switch (config.periodType) {
    case 'weekly': return 7;
    case 'biweekly': return 14;
    case 'semimonthly':
      return dayOfMonth(periodStart) === 1 ? 15 : daysInMonth(periodStart) - 15;
    case 'monthly':
      return daysInMonth(periodStart);
  }
}

/**
 * Returns the period start that contains `day`.
 * Biweekly: period number = floor(diffDays(anchor, day) / 14) on dates — this is exact integer
 * day arithmetic on calendar dates, so it can never land on the wrong weekday (the old bug: an
 * anchor stored at UTC midnight, diffed in a US browser, used to yield a Sunday start).
 */
export function getPeriodStartForDate(day: CalendarDate, config: PeriodConfig): CalendarDate {
  switch (config.periodType) {
    case 'weekly': {
      let start = day;
      while (dayOfWeek(start) !== config.weekStartDay) {
        start = addDays(start, -1);
      }
      return start;
    }
    case 'biweekly': {
      const periodNumber = Math.floor(diffDays(config.anchorDate, day) / 14);
      return addDays(config.anchorDate, periodNumber * 14);
    }
    case 'semimonthly':
      return dayOfMonth(day) <= 15 ? startOfMonth(day) : withDayOfMonth(day, 16);
    case 'monthly':
      return startOfMonth(day);
  }
}

/** The period start containing `today` — `today` must be passed explicitly (no hidden clock). */
export function getCurrentPeriodStart(today: CalendarDate, config: PeriodConfig): CalendarDate {
  return getPeriodStartForDate(today, config);
}

/** Navigate to the next or previous pay period. */
export function navigatePeriod(
  periodStart: CalendarDate,
  direction: 'prev' | 'next',
  config: PeriodConfig
): CalendarDate {
  const delta = direction === 'next' ? 1 : -1;

  switch (config.periodType) {
    case 'weekly': return addDays(periodStart, delta * 7);
    case 'biweekly': return addDays(periodStart, delta * 14);
    case 'semimonthly': {
      if (direction === 'next') {
        return dayOfMonth(periodStart) === 1
          ? withDayOfMonth(periodStart, 16)
          : withDayOfMonth(addMonths(periodStart, 1), 1);
      }
      return dayOfMonth(periodStart) === 1
        ? withDayOfMonth(addMonths(periodStart, -1), 16)
        : withDayOfMonth(periodStart, 1);
    }
    case 'monthly':
      return withDayOfMonth(addMonths(periodStart, delta), 1);
  }
}

/** Returns the last date of a pay period (inclusive). */
export function getPeriodEndDate(periodStart: CalendarDate, config: PeriodConfig): CalendarDate {
  const numDays = getNumDaysInPeriod(periodStart, config);
  return addDays(periodStart, numDays - 1);
}

/**
 * Returns the last weekday (Mon–Fri) in a pay period.
 * The submit deadline is the last business day, not the last calendar day.
 */
export function getLastWeekdayInPeriod(periodStart: CalendarDate, config: PeriodConfig): CalendarDate {
  const numDays = getNumDaysInPeriod(periodStart, config);
  let lastDay = addDays(periodStart, numDays - 1);

  while (dayOfWeek(lastDay) === 0 || dayOfWeek(lastDay) === 6) {
    lastDay = addDays(lastDay, -1);
  }

  return lastDay;
}
