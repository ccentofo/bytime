import { describe, it, expect, vi } from 'vitest';
import {
  type CalendarDate,
  isCalendarDate,
  parseCalendarDate,
  addDays,
  diffDays,
  dayOfWeek,
  dayOfMonth,
  daysInMonth,
  startOfMonth,
  withDayOfMonth,
  addMonths,
  compare,
  isBefore,
  isAfter,
  max,
  min,
  todayIn,
  isValidTimeZone,
  formatCalendarDate,
  formatInstant,
  canonicalTimeZone,
  calendarDayOf,
} from '@/lib/calendar-date';
import { isUniqueViolation } from '@/lib/db-errors';

const d = (s: string) => s as CalendarDate;

describe('isCalendarDate / parseCalendarDate', () => {
  it('accepts well-formed, real dates', () => {
    expect(isCalendarDate('2026-11-01')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true); // leap day
    expect(isCalendarDate('2026-01-01')).toBe(true);
    expect(isCalendarDate('2026-12-31')).toBe(true);
  });

  it('rejects non-existent dates (month/day overflow)', () => {
    expect(isCalendarDate('2026-02-30')).toBe(false); // Feb has 28 days in 2026
    expect(isCalendarDate('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isCalendarDate('2026-04-31')).toBe(false); // April has 30 days
    expect(isCalendarDate('2026-13-01')).toBe(false); // month 13
    expect(isCalendarDate('2026-00-01')).toBe(false); // month 0
  });

  it('rejects malformed input', () => {
    expect(isCalendarDate('')).toBe(false);
    expect(isCalendarDate('not-a-date')).toBe(false);
    expect(isCalendarDate('2026-11-1')).toBe(false); // not zero-padded
    expect(isCalendarDate('2026/11/01')).toBe(false);
    expect(isCalendarDate('2026-11-01T00:00:00')).toBe(false); // instant, not a calendar date
    expect(isCalendarDate('2026-11-01T00:00:00Z')).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(20261101)).toBe(false);
    expect(isCalendarDate(new Date('2026-11-01'))).toBe(false);
  });

  it('parseCalendarDate returns the branded value for valid input', () => {
    expect(parseCalendarDate('2026-11-01')).toBe('2026-11-01');
  });

  it('parseCalendarDate throws for invalid input', () => {
    expect(() => parseCalendarDate('2026-02-30')).toThrow(/Invalid calendar date/);
    expect(() => parseCalendarDate('garbage')).toThrow(/Invalid calendar date/);
    expect(() => parseCalendarDate(null)).toThrow(/Invalid calendar date/);
    expect(() => parseCalendarDate(42)).toThrow(/Invalid calendar date/);
  });
});

describe('addDays / diffDays', () => {
  it('adds and subtracts days across a month boundary', () => {
    expect(addDays(d('2026-01-28'), 5)).toBe('2026-02-02');
    expect(addDays(d('2026-02-02'), -5)).toBe('2026-01-28');
  });

  it('adds across a year boundary', () => {
    expect(addDays(d('2026-12-29'), 5)).toBe('2027-01-03');
  });

  it('handles the Feb 29 leap day correctly', () => {
    expect(addDays(d('2024-02-28'), 1)).toBe('2024-02-29');
    expect(addDays(d('2024-02-29'), 1)).toBe('2024-03-01');
    // 2026 is not a leap year — Feb 28 + 1 day skips straight to Mar 1.
    expect(addDays(d('2026-02-28'), 1)).toBe('2026-03-01');
  });

  it('is a no-op for n=0', () => {
    expect(addDays(d('2026-06-15'), 0)).toBe('2026-06-15');
  });

  it('diffDays is the exact integer day count, positive when b is after a', () => {
    expect(diffDays(d('2026-01-01'), d('2026-01-15'))).toBe(14);
    expect(diffDays(d('2026-01-15'), d('2026-01-01'))).toBe(-14);
    expect(diffDays(d('2026-01-01'), d('2026-01-01'))).toBe(0);
  });

  it('diffDays across a DST-change week is still a plain calendar-day count (no 23/25-hour days)', () => {
    // US DST ended 2026-11-01 (a Sunday) — a UTC-anchored diff must still read exactly 7.
    expect(diffDays(d('2026-10-25'), d('2026-11-01'))).toBe(7);
    // US DST begins 2026-03-08.
    expect(diffDays(d('2026-03-01'), d('2026-03-08'))).toBe(7);
  });
});

describe('dayOfWeek / dayOfMonth / daysInMonth', () => {
  it('dayOfWeek returns 0 (Sun) through 6 (Sat)', () => {
    expect(dayOfWeek(d('2026-11-01'))).toBe(0); // Sunday
    expect(dayOfWeek(d('2026-11-02'))).toBe(1); // Monday
    expect(dayOfWeek(d('2026-11-07'))).toBe(6); // Saturday
  });

  it('dayOfMonth returns 1-31', () => {
    expect(dayOfMonth(d('2026-11-01'))).toBe(1);
    expect(dayOfMonth(d('2026-11-30'))).toBe(30);
  });

  it('daysInMonth accounts for leap years', () => {
    expect(daysInMonth(d('2026-02-01'))).toBe(28);
    expect(daysInMonth(d('2024-02-01'))).toBe(29);
    expect(daysInMonth(d('2026-01-01'))).toBe(31);
    expect(daysInMonth(d('2026-04-01'))).toBe(30);
  });
});

describe('startOfMonth / withDayOfMonth / addMonths', () => {
  it('startOfMonth returns the 1st of the given date\'s month', () => {
    expect(startOfMonth(d('2026-11-17'))).toBe('2026-11-01');
  });

  it('withDayOfMonth sets the day-of-month', () => {
    expect(withDayOfMonth(d('2026-11-01'), 16)).toBe('2026-11-16');
    expect(withDayOfMonth(d('2026-11-30'), 1)).toBe('2026-11-01');
  });

  it('addMonths clamps to the target month\'s last day rather than overflowing', () => {
    expect(addMonths(d('2026-01-31'), 1)).toBe('2026-02-28'); // Feb 2026 has 28 days
    expect(addMonths(d('2024-01-31'), 1)).toBe('2024-02-29'); // leap year
  });

  it('addMonths across a year boundary', () => {
    expect(addMonths(d('2026-12-01'), 1)).toBe('2027-01-01');
    expect(addMonths(d('2026-01-01'), -1)).toBe('2025-12-01');
  });
});

describe('compare / isBefore / isAfter / max / min', () => {
  it('compare returns -1, 0, 1', () => {
    expect(compare(d('2026-01-01'), d('2026-01-02'))).toBe(-1);
    expect(compare(d('2026-01-02'), d('2026-01-01'))).toBe(1);
    expect(compare(d('2026-01-01'), d('2026-01-01'))).toBe(0);
  });

  it('isBefore / isAfter', () => {
    expect(isBefore(d('2026-01-01'), d('2026-01-02'))).toBe(true);
    expect(isBefore(d('2026-01-02'), d('2026-01-01'))).toBe(false);
    expect(isAfter(d('2026-01-02'), d('2026-01-01'))).toBe(true);
  });

  it('max / min across a year boundary (plain string comparison must still sort correctly)', () => {
    expect(max(d('2026-12-31'), d('2027-01-01'), d('2026-06-15'))).toBe('2027-01-01');
    expect(min(d('2026-12-31'), d('2027-01-01'), d('2026-06-15'))).toBe('2026-06-15');
  });
});

describe('timezone helpers', () => {
  it('isValidTimeZone accepts real IANA names and rejects garbage', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Pacific/Auckland')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('todayIn computes the calendar date for a specific instant per the IANA zone', () => {
    // 2026-01-01T04:30:00Z is Dec 31 evening in New York (UTC-5) but Jan 1 in UTC.
    // dayjs() calls `new Date()` directly, so only vi.setSystemTime (not reassigning
    // Date.now) actually changes what it sees.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T04:30:00Z'));
    try {
      expect(todayIn('UTC')).toBe('2026-01-01');
      expect(todayIn('America/New_York')).toBe('2025-12-31');
      expect(todayIn('Pacific/Auckland')).toBe('2026-01-01'); // UTC+13, already Jan 1
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatCalendarDate', () => {
  it('formats without depending on the process timezone', () => {
    expect(formatCalendarDate(d('2026-11-01'), 'MMM D')).toBe('Nov 1');
    expect(formatCalendarDate(d('2026-11-01'), 'M/D')).toBe('11/1');
    expect(formatCalendarDate(d('2026-11-01'), 'YYYY-MM-DD')).toBe('2026-11-01');
  });
});

describe('formatInstant', () => {
  it('includes the zone abbreviation and reflects the given timezone', () => {
    // 2026-10-21 20:05:00Z is 4:05 PM EDT in New York (DST active in October).
    const instant = new Date('2026-10-21T20:05:00Z');
    const formatted = formatInstant(instant, 'America/New_York', 'MMM D, YYYY h:mm A');
    expect(formatted).toBe('Oct 21, 2026 4:05 PM EDT');
  });

  it('reflects standard time (EST) outside DST', () => {
    // 2026-01-15 20:05:00Z is 3:05 PM EST in New York (DST inactive in January).
    const instant = new Date('2026-01-15T20:05:00Z');
    const formatted = formatInstant(instant, 'America/New_York', 'MMM D, YYYY h:mm A');
    expect(formatted).toBe('Jan 15, 2026 3:05 PM EST');
  });

  it('a different timezone produces a different wall-clock time for the same instant', () => {
    const instant = new Date('2026-10-21T20:05:00Z');
    const nyFormatted = formatInstant(instant, 'America/New_York', 'h:mm A');
    const aucklandFormatted = formatInstant(instant, 'Pacific/Auckland', 'h:mm A');
    expect(nyFormatted).not.toBe(aucklandFormatted);
  });
});

describe('canonicalTimeZone / calendarDayOf', () => {
  it('returns the canonical IANA name for region zones and UTC', () => {
    expect(canonicalTimeZone('America/New_York')).toBe('America/New_York');
    expect(canonicalTimeZone('america/new_york')).toBe('America/New_York');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    expect(canonicalTimeZone('US/Eastern')).toBe('America/New_York');
  });

  it('rejects abbreviations, raw offsets, non-strings, and garbage', () => {
    for (const bad of ['EST', 'PST', '+05:00', 'EST5EDT', 'Etc/GMT+5', '', 'Not/AZone', undefined, null, 42, ['UTC']]) {
      expect(canonicalTimeZone(bad), String(bad)).toBeNull();
      expect(isValidTimeZone(bad), String(bad)).toBe(false);
    }
  });

  it('calendarDayOf gives the day an instant falls on in a timezone', () => {
    const instant = new Date('2026-11-02T03:30:00Z'); // 10:30pm Nov 1 in New York (EST)
    expect(calendarDayOf(instant, 'America/New_York')).toBe('2026-11-01');
    expect(calendarDayOf(instant, 'UTC')).toBe('2026-11-02');
  });
});

describe('isUniqueViolation', () => {
  it('reads the SQLSTATE from the driver error Drizzle wraps in .cause', () => {
    const wrapped = Object.assign(new Error('Failed query: insert … params: unique'), {
      cause: { code: '23505', constraint_name: 'entries_user_code_date_rev_unique_idx' },
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped, 'entries_user_code_date_rev_unique_idx')).toBe(true);
    expect(isUniqueViolation(wrapped, 'some_other_idx')).toBe(false);
  });

  it('never matches on message text', () => {
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint'))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error('x'), { cause: { code: '23503' } }))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
