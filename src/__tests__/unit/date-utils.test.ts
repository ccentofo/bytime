import { describe, it, expect } from 'vitest';
import {
  getNumDaysInPeriod,
  getCurrentPeriodStart,
  getPeriodStartForDate,
  navigatePeriod,
  getPeriodEndDate,
  getLastWeekdayInPeriod,
  DEFAULT_PERIOD_CONFIG,
  type PeriodConfig,
} from '@/lib/date-utils';
import type { CalendarDate } from '@/lib/calendar-date';

const d = (s: string) => s as CalendarDate;

const semimonthlyConfig: PeriodConfig = { periodType: 'semimonthly', anchorDate: d('2026-01-01'), weekStartDay: 1 };
const weeklyConfig: PeriodConfig = { periodType: 'weekly', anchorDate: d('2026-01-05'), weekStartDay: 1 };
const biweeklyConfig: PeriodConfig = { periodType: 'biweekly', anchorDate: d('2026-01-05'), weekStartDay: 1 };
const monthlyConfig: PeriodConfig = { periodType: 'monthly', anchorDate: d('2026-01-01'), weekStartDay: 1 };

describe('getNumDaysInPeriod', () => {
  it('semimonthly: 15 days from the 1st', () => {
    expect(getNumDaysInPeriod(d('2026-01-01'), semimonthlyConfig)).toBe(15);
    expect(getNumDaysInPeriod(d('2026-06-01'), semimonthlyConfig)).toBe(15);
  });

  it('semimonthly: remaining days of the month from the 16th', () => {
    expect(getNumDaysInPeriod(d('2026-01-16'), semimonthlyConfig)).toBe(16); // Jan has 31 days
    expect(getNumDaysInPeriod(d('2026-02-16'), semimonthlyConfig)).toBe(13); // Feb has 28 days (2026 not a leap year)
    expect(getNumDaysInPeriod(d('2026-04-16'), semimonthlyConfig)).toBe(15); // Apr has 30 days
    expect(getNumDaysInPeriod(d('2024-02-16'), semimonthlyConfig)).toBe(14); // leap year Feb has 29 days
  });

  it('weekly period is always 7 days', () => {
    expect(getNumDaysInPeriod(d('2026-06-01'), weeklyConfig)).toBe(7);
    expect(getNumDaysInPeriod(d('2026-06-08'), weeklyConfig)).toBe(7);
  });

  it('biweekly period is always 14 days', () => {
    expect(getNumDaysInPeriod(d('2026-06-01'), biweeklyConfig)).toBe(14);
  });

  it('monthly period matches calendar month days', () => {
    expect(getNumDaysInPeriod(d('2026-01-01'), monthlyConfig)).toBe(31);
    expect(getNumDaysInPeriod(d('2026-02-01'), monthlyConfig)).toBe(28);
    expect(getNumDaysInPeriod(d('2024-02-01'), monthlyConfig)).toBe(29);
    expect(getNumDaysInPeriod(d('2026-04-01'), monthlyConfig)).toBe(30);
  });
});

describe('getPeriodStartForDate', () => {
  it('semimonthly snaps to the 1st or the 16th', () => {
    expect(getPeriodStartForDate(d('2026-05-10'), semimonthlyConfig)).toBe('2026-05-01');
    expect(getPeriodStartForDate(d('2026-05-20'), semimonthlyConfig)).toBe('2026-05-16');
    expect(getPeriodStartForDate(d('2026-05-01'), semimonthlyConfig)).toBe('2026-05-01');
    expect(getPeriodStartForDate(d('2026-05-16'), semimonthlyConfig)).toBe('2026-05-16');
  });

  it('weekly snaps to the configured week-start day', () => {
    // 2026-06-03 is a Wednesday; weekStartDay=1 (Monday) → most recent Monday is 2026-06-01.
    expect(getPeriodStartForDate(d('2026-06-03'), weeklyConfig)).toBe('2026-06-01');
  });

  it('biweekly computes an EXACT period start from the anchor — never a Sunday off-by-one', () => {
    // Anchor 2026-01-05 (Monday). 2026-06-01 is 147 days after the anchor; 147/14 = 10.5,
    // floor(10.5) = 10 periods elapsed → period start = anchor + 140 days = 2026-05-25 (Monday).
    const result = getPeriodStartForDate(d('2026-06-01'), biweeklyConfig);
    expect(result).toBe('2026-05-25');
    // Exact assertion, not a range check: must land ON the anchor's weekday.
    expect(getPeriodStartForDate(d('2026-01-05'), biweeklyConfig)).toBe('2026-01-05');
    expect(getPeriodStartForDate(d('2026-01-18'), biweeklyConfig)).toBe('2026-01-05');
    expect(getPeriodStartForDate(d('2026-01-19'), biweeklyConfig)).toBe('2026-01-19');
  });

  it('monthly snaps to the 1st', () => {
    expect(getPeriodStartForDate(d('2026-06-15'), monthlyConfig)).toBe('2026-06-01');
  });
});

describe('getCurrentPeriodStart (today passed explicitly)', () => {
  it('semimonthly: 1st when today is in the first half', () => {
    expect(getCurrentPeriodStart(d('2026-05-10'), semimonthlyConfig)).toBe('2026-05-01');
  });

  it('semimonthly: 16th when today is in the second half', () => {
    expect(getCurrentPeriodStart(d('2026-05-20'), semimonthlyConfig)).toBe('2026-05-16');
  });

  it('weekly returns the most recent configured week-start day', () => {
    expect(getCurrentPeriodStart(d('2026-06-03'), weeklyConfig)).toBe('2026-06-01');
  });

  it('monthly returns the 1st of the current month', () => {
    expect(getCurrentPeriodStart(d('2026-06-15'), monthlyConfig)).toBe('2026-06-01');
  });

  it('biweekly computes an exact date from the anchor', () => {
    expect(getCurrentPeriodStart(d('2026-06-01'), biweeklyConfig)).toBe('2026-05-25');
  });
});

describe('navigatePeriod', () => {
  it('semimonthly: 1st → 16th → next month 1st', () => {
    expect(navigatePeriod(d('2026-05-01'), 'next', semimonthlyConfig)).toBe('2026-05-16');
    expect(navigatePeriod(d('2026-05-16'), 'next', semimonthlyConfig)).toBe('2026-06-01');
  });

  it('semimonthly: backward from 16th to 1st, and from 1st to previous month 16th', () => {
    expect(navigatePeriod(d('2026-05-16'), 'prev', semimonthlyConfig)).toBe('2026-05-01');
    expect(navigatePeriod(d('2026-05-01'), 'prev', semimonthlyConfig)).toBe('2026-04-16');
  });

  it('weekly navigates by 7 days', () => {
    expect(navigatePeriod(d('2026-06-01'), 'next', weeklyConfig)).toBe('2026-06-08');
    expect(navigatePeriod(d('2026-06-08'), 'prev', weeklyConfig)).toBe('2026-06-01');
  });

  it('biweekly navigates by exactly 14 days', () => {
    expect(navigatePeriod(d('2026-06-01'), 'next', biweeklyConfig)).toBe('2026-06-15');
    expect(navigatePeriod(d('2026-06-15'), 'prev', biweeklyConfig)).toBe('2026-06-01');
  });

  it('monthly navigates by calendar month, year boundary included', () => {
    expect(navigatePeriod(d('2026-06-01'), 'next', monthlyConfig)).toBe('2026-07-01');
    expect(navigatePeriod(d('2026-06-01'), 'prev', monthlyConfig)).toBe('2026-05-01');
    expect(navigatePeriod(d('2026-12-01'), 'next', monthlyConfig)).toBe('2027-01-01');
  });
});

describe('getPeriodEndDate', () => {
  it('semimonthly', () => {
    expect(getPeriodEndDate(d('2026-01-01'), semimonthlyConfig)).toBe('2026-01-15');
    expect(getPeriodEndDate(d('2026-01-16'), semimonthlyConfig)).toBe('2026-01-31');
  });

  it('weekly', () => {
    expect(getPeriodEndDate(d('2026-06-01'), weeklyConfig)).toBe('2026-06-07');
  });

  it('monthly, leap year', () => {
    expect(getPeriodEndDate(d('2024-02-01'), monthlyConfig)).toBe('2024-02-29');
  });
});

describe('getLastWeekdayInPeriod', () => {
  it('walks back from the period end to the nearest weekday', () => {
    // 2026-01-01 .. 2026-01-15 (semimonthly), Jan 15 2026 is a Thursday — already a weekday.
    expect(getLastWeekdayInPeriod(d('2026-01-01'), semimonthlyConfig)).toBe('2026-01-15');
  });

  it('skips back over a weekend', () => {
    // Jan 16 .. Jan 31 2026; Jan 31 2026 is a Saturday → last weekday is Fri Jan 30.
    expect(getLastWeekdayInPeriod(d('2026-01-16'), semimonthlyConfig)).toBe('2026-01-30');
  });
});

// ---------------------------------------------------------------------------
// Period Config Snapshot Tests — DCAA Compliance (rewritten to CalendarDate strings)
// ---------------------------------------------------------------------------

describe('period config snapshot — DCAA integrity', () => {
  it('historical semi-monthly period maintains 15-day boundary regardless of current config', () => {
    const historicalPeriodStart = d('2026-05-01');
    const originalDays = getNumDaysInPeriod(historicalPeriodStart, semimonthlyConfig);
    expect(originalDays).toBe(15);
    const newConfigDays = getNumDaysInPeriod(historicalPeriodStart, biweeklyConfig);
    expect(newConfigDays).toBe(14);
    expect(originalDays).not.toBe(newConfigDays);
  });

  it('stored period config overrides global config for navigation', () => {
    const periodStart = d('2026-06-01');
    const nextWithStored = navigatePeriod(periodStart, 'next', semimonthlyConfig);
    expect(nextWithStored).toBe('2026-06-16');
    const nextWithNew = navigatePeriod(periodStart, 'next', biweeklyConfig);
    expect(nextWithNew).toBe('2026-06-15');
    expect(nextWithStored).not.toBe(nextWithNew);
  });

  it('period boundary is deterministic from stored config', () => {
    const storedPeriodType = 'semimonthly' as const;
    const storedNumDays = 15;
    const periodStart = d('2026-05-01');
    const reconstructedConfig: PeriodConfig = {
      periodType: storedPeriodType,
      anchorDate: d('2026-01-01'),
      weekStartDay: 1,
    };
    expect(getNumDaysInPeriod(periodStart, reconstructedConfig)).toBe(storedNumDays);
  });

  it('approved period under bi-weekly stays 14 days after config change to monthly', () => {
    const biweeklyStart = d('2026-06-08');
    expect(getNumDaysInPeriod(biweeklyStart, biweeklyConfig)).toBe(14);
    expect(getNumDaysInPeriod(d('2026-06-01'), monthlyConfig)).toBe(30);
    const storedConfig: PeriodConfig = { periodType: 'biweekly', anchorDate: d('2026-01-05'), weekStartDay: 1 };
    expect(getNumDaysInPeriod(biweeklyStart, storedConfig)).toBe(14);
  });

  it('DEFAULT_PERIOD_CONFIG is semimonthly (used only as the no-config-row fallback, never a parameter default)', () => {
    expect(DEFAULT_PERIOD_CONFIG.periodType).toBe('semimonthly');
  });
});
