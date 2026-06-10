import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Period Configuration Types
// ---------------------------------------------------------------------------

export type PeriodType = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface PeriodConfig {
  periodType: PeriodType;
  anchorDate: Date;
  weekStartDay: number; // 0=Sun, 1=Mon
}

// Default config (backward compatible — semi-monthly is the original behavior)
export const DEFAULT_PERIOD_CONFIG: PeriodConfig = {
  periodType: 'semimonthly',
  anchorDate: new Date('2026-01-01'),
  weekStartDay: 1,
};

// ---------------------------------------------------------------------------
// Core Period Utilities
// ---------------------------------------------------------------------------

/**
 * Returns the number of days in a pay period.
 * Defaults to semi-monthly (backward compatible).
 */
export function getNumDaysInPeriod(periodStart: Date, config: PeriodConfig = DEFAULT_PERIOD_CONFIG): number {
  switch (config.periodType) {
    case 'weekly': return 7;
    case 'biweekly': return 14;
    case 'semimonthly': {
      const d = dayjs(periodStart);
      return d.date() === 1 ? 15 : d.daysInMonth() - 15;
    }
    case 'monthly': return dayjs(periodStart).daysInMonth();
  }
}

/**
 * Returns the current period start date.
 * Defaults to semi-monthly (backward compatible).
 */
export function getCurrentPeriodStart(config: PeriodConfig = DEFAULT_PERIOD_CONFIG): Date {
  const now = dayjs();
  switch (config.periodType) {
    case 'weekly': {
      // Find the most recent weekStartDay
      let start = now.startOf('day');
      while (start.day() !== config.weekStartDay) {
        start = start.subtract(1, 'day');
      }
      return start.toDate();
    }
    case 'biweekly': {
      // Calculate based on anchor date
      const anchor = dayjs(config.anchorDate);
      const daysSinceAnchor = now.diff(anchor, 'day');
      const periodNumber = Math.floor(daysSinceAnchor / 14);
      return anchor.add(periodNumber * 14, 'day').startOf('day').toDate();
    }
    case 'semimonthly': {
      if (now.date() <= 15) return now.date(1).startOf('day').toDate();
      return now.date(16).startOf('day').toDate();
    }
    case 'monthly':
      return now.date(1).startOf('day').toDate();
  }
}

/**
 * Navigate to the next or previous pay period.
 * Defaults to semi-monthly (backward compatible).
 */
export function navigatePeriod(
  periodStart: Date,
  direction: 'prev' | 'next',
  config: PeriodConfig = DEFAULT_PERIOD_CONFIG
): Date {
  const current = dayjs(periodStart);
  const delta = direction === 'next' ? 1 : -1;

  switch (config.periodType) {
    case 'weekly': return current.add(delta * 7, 'day').toDate();
    case 'biweekly': return current.add(delta * 14, 'day').toDate();
    case 'semimonthly': {
      if (direction === 'next') {
        return current.date() === 1
          ? current.date(16).toDate()
          : current.add(1, 'month').date(1).toDate();
      }
      return current.date() === 1
        ? current.subtract(1, 'month').date(16).toDate()
        : current.date(1).toDate();
    }
    case 'monthly':
      return current.add(delta, 'month').date(1).toDate();
  }
}

/**
 * Returns the last date of a pay period (inclusive).
 */
export function getPeriodEndDate(periodStart: Date, config: PeriodConfig = DEFAULT_PERIOD_CONFIG): Date {
  const numDays = getNumDaysInPeriod(periodStart, config);
  return dayjs(periodStart).add(numDays - 1, 'day').startOf('day').toDate();
}

/**
 * Returns the last weekday (Mon-Fri) in a pay period.
 * The submit deadline is the last business day, not the last calendar day.
 */
export function getLastWeekdayInPeriod(periodStart: Date, config: PeriodConfig = DEFAULT_PERIOD_CONFIG): Date {
  const numDays = getNumDaysInPeriod(periodStart, config);
  let lastDay = dayjs(periodStart).add(numDays - 1, 'day');

  // Walk backward until we find a weekday
  while (lastDay.day() === 0 || lastDay.day() === 6) {
    lastDay = lastDay.subtract(1, 'day');
  }

  return lastDay.toDate();
}
