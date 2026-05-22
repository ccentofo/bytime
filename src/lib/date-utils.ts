import dayjs from 'dayjs';

/**
 * Returns the number of days in a semi-monthly pay period.
 * Period A: 1st–15th = always 15 days
 * Period B: 16th–end of month = varies (13–16 days)
 */
export function getNumDaysInPeriod(periodStart: Date): number {
  const d = dayjs(periodStart);
  if (d.date() === 1) {
    return 15; // 1st through 15th
  }
  // 16th through end of month
  return d.daysInMonth() - 15;
}

/**
 * Returns the default period start date (1st or 16th of the current month).
 */
export function getCurrentPeriodStart(): Date {
  const now = dayjs();
  if (now.date() <= 15) {
    return now.date(1).startOf('day').toDate();
  }
  return now.date(16).startOf('day').toDate();
}

/**
 * Navigate to the next or previous semi-monthly period.
 */
export function navigatePeriod(periodStart: Date, direction: 'prev' | 'next'): Date {
  const current = dayjs(periodStart);

  if (direction === 'next') {
    if (current.date() === 1) {
      return current.date(16).toDate();
    }
    return current.add(1, 'month').date(1).toDate();
  } else {
    if (current.date() === 1) {
      return current.subtract(1, 'month').date(16).toDate();
    }
    return current.date(1).toDate();
  }
}

/**
 * Returns the last date of a semi-monthly pay period (inclusive).
 * Period A (starts 1st): ends on 15th
 * Period B (starts 16th): ends on last day of month
 */
export function getPeriodEndDate(periodStart: Date): Date {
  const numDays = getNumDaysInPeriod(periodStart);
  return dayjs(periodStart).add(numDays - 1, 'day').startOf('day').toDate();
}
