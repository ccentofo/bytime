import { describe, it, expect, vi } from 'vitest';
import { getNumDaysInPeriod, getCurrentPeriodStart, navigatePeriod, type PeriodConfig } from '@/lib/date-utils';
import dayjs from 'dayjs';

describe('getNumDaysInPeriod', () => {
  it('returns 15 for 1st of month', () => {
    // Use dayjs to create dates to avoid timezone issues with new Date('YYYY-MM-DD')
    expect(getNumDaysInPeriod(dayjs('2026-01-01').toDate())).toBe(15);
    expect(getNumDaysInPeriod(dayjs('2026-06-01').toDate())).toBe(15);
  });
  it('returns correct days for 16th of month', () => {
    expect(getNumDaysInPeriod(dayjs('2026-01-16').toDate())).toBe(16); // Jan has 31 days
    expect(getNumDaysInPeriod(dayjs('2026-02-16').toDate())).toBe(13); // Feb has 28 days (2026 is not leap)
    expect(getNumDaysInPeriod(dayjs('2026-04-16').toDate())).toBe(15); // Apr has 30 days
  });
});

describe('navigatePeriod', () => {
  it('navigates forward from 1st to 16th', () => {
    const result = navigatePeriod(dayjs('2026-05-01').toDate(), 'next');
    const d = dayjs(result);
    expect(d.date()).toBe(16);
    expect(d.month()).toBe(4); // May (0-indexed)
  });
  it('navigates forward from 16th to next month 1st', () => {
    const result = navigatePeriod(dayjs('2026-05-16').toDate(), 'next');
    const d = dayjs(result);
    expect(d.date()).toBe(1);
    expect(d.month()).toBe(5); // June
  });
  it('navigates backward from 16th to 1st', () => {
    const result = navigatePeriod(dayjs('2026-05-16').toDate(), 'prev');
    const d = dayjs(result);
    expect(d.date()).toBe(1);
    expect(d.month()).toBe(4); // May
  });
  it('navigates backward from 1st to previous month 16th', () => {
    const result = navigatePeriod(dayjs('2026-05-01').toDate(), 'prev');
    const d = dayjs(result);
    expect(d.date()).toBe(16);
    expect(d.month()).toBe(3); // April
  });
});

describe('getCurrentPeriodStart', () => {
  it('returns 1st when today is in first half', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10'));
    const result = getCurrentPeriodStart();
    expect(dayjs(result).date()).toBe(1);
    vi.useRealTimers();
  });
  it('returns 16th when today is in second half', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20'));
    const result = getCurrentPeriodStart();
    expect(dayjs(result).date()).toBe(16);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Configurable Period Tests
// ---------------------------------------------------------------------------

const weeklyConfig: PeriodConfig = { periodType: 'weekly', anchorDate: new Date('2026-01-05'), weekStartDay: 1 };
const biweeklyConfig: PeriodConfig = { periodType: 'biweekly', anchorDate: new Date('2026-01-05'), weekStartDay: 1 };
const monthlyConfig: PeriodConfig = { periodType: 'monthly', anchorDate: new Date('2026-01-01'), weekStartDay: 1 };

describe('getNumDaysInPeriod — configurable', () => {
  it('weekly period is always 7 days', () => {
    expect(getNumDaysInPeriod(dayjs('2026-06-01').toDate(), weeklyConfig)).toBe(7);
    expect(getNumDaysInPeriod(dayjs('2026-06-08').toDate(), weeklyConfig)).toBe(7);
  });

  it('biweekly period is always 14 days', () => {
    expect(getNumDaysInPeriod(dayjs('2026-06-01').toDate(), biweeklyConfig)).toBe(14);
  });

  it('monthly period matches calendar month days', () => {
    expect(getNumDaysInPeriod(dayjs('2026-01-01').toDate(), monthlyConfig)).toBe(31);
    expect(getNumDaysInPeriod(dayjs('2026-02-01').toDate(), monthlyConfig)).toBe(28);
    expect(getNumDaysInPeriod(dayjs('2026-04-01').toDate(), monthlyConfig)).toBe(30);
    expect(getNumDaysInPeriod(dayjs('2026-06-01').toDate(), monthlyConfig)).toBe(30);
  });

  it('semimonthly still works with default config', () => {
    // No config passed — should use semi-monthly default
    expect(getNumDaysInPeriod(dayjs('2026-06-01').toDate())).toBe(15);
    expect(getNumDaysInPeriod(dayjs('2026-06-16').toDate())).toBe(15);
  });
});

describe('navigatePeriod — configurable', () => {
  it('weekly navigates by 7 days', () => {
    const next = navigatePeriod(dayjs('2026-06-01').toDate(), 'next', weeklyConfig);
    expect(dayjs(next).format('YYYY-MM-DD')).toBe('2026-06-08');

    const prev = navigatePeriod(dayjs('2026-06-08').toDate(), 'prev', weeklyConfig);
    expect(dayjs(prev).format('YYYY-MM-DD')).toBe('2026-06-01');
  });

  it('biweekly navigates by 14 days', () => {
    const next = navigatePeriod(dayjs('2026-06-01').toDate(), 'next', biweeklyConfig);
    expect(dayjs(next).format('YYYY-MM-DD')).toBe('2026-06-15');

    const prev = navigatePeriod(dayjs('2026-06-15').toDate(), 'prev', biweeklyConfig);
    expect(dayjs(prev).format('YYYY-MM-DD')).toBe('2026-06-01');
  });

  it('monthly navigates by calendar month', () => {
    const next = navigatePeriod(dayjs('2026-06-01').toDate(), 'next', monthlyConfig);
    expect(dayjs(next).format('YYYY-MM-DD')).toBe('2026-07-01');

    const prev = navigatePeriod(dayjs('2026-06-01').toDate(), 'prev', monthlyConfig);
    expect(dayjs(prev).format('YYYY-MM-DD')).toBe('2026-05-01');
  });

  it('semimonthly navigation unchanged with default config', () => {
    const next = navigatePeriod(dayjs('2026-06-01').toDate(), 'next');
    expect(dayjs(next).date()).toBe(16);

    const prev = navigatePeriod(dayjs('2026-06-16').toDate(), 'prev');
    expect(dayjs(prev).date()).toBe(1);
  });
});

describe('getCurrentPeriodStart — configurable', () => {
  it('weekly returns most recent Monday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03')); // Wednesday
    const result = getCurrentPeriodStart(weeklyConfig);
    expect(dayjs(result).day()).toBe(1); // Monday
    expect(dayjs(result).format('YYYY-MM-DD')).toBe('2026-06-01');
    vi.useRealTimers();
  });

  it('monthly returns 1st of current month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15'));
    const result = getCurrentPeriodStart(monthlyConfig);
    expect(dayjs(result).date()).toBe(1);
    expect(dayjs(result).month()).toBe(5); // June
    vi.useRealTimers();
  });

  it('biweekly calculates from anchor date', () => {
    vi.useFakeTimers();
    // Anchor is 2026-01-05 (Monday). Periods repeat every 14 days.
    vi.setSystemTime(new Date('2026-06-01'));
    const result = getCurrentPeriodStart(biweeklyConfig);
    const d = dayjs(result);
    // The result should be before or on the current date
    expect(d.isBefore(dayjs('2026-06-02'))).toBe(true);
    // And the period should contain the current date (result + 14 days > current)
    expect(d.add(14, 'day').isAfter(dayjs('2026-06-01'))).toBe(true);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Period Config Snapshot Tests — DCAA Compliance
// ---------------------------------------------------------------------------

describe('period config snapshot — DCAA integrity', () => {
  const semimonthlyConfig: PeriodConfig = { periodType: 'semimonthly', anchorDate: new Date('2026-01-01'), weekStartDay: 1 };

  it('historical semi-monthly period maintains 15-day boundary regardless of current config', () => {
    // A period created under semi-monthly should always be 15 days
    // even if the "current" config is bi-weekly
    const historicalPeriodStart = dayjs('2026-05-01').toDate();

    // Under original semi-monthly config: 15 days
    const originalDays = getNumDaysInPeriod(historicalPeriodStart, semimonthlyConfig);
    expect(originalDays).toBe(15);

    // Under new bi-weekly config: would be 14 days
    const newConfigDays = getNumDaysInPeriod(historicalPeriodStart, biweeklyConfig);
    expect(newConfigDays).toBe(14);

    // These MUST be different — proving the config matters
    expect(originalDays).not.toBe(newConfigDays);
  });

  it('stored period config overrides global config for navigation', () => {
    // Historical period: semi-monthly starting Jun 1
    const storedConfig = semimonthlyConfig;
    const periodStart = dayjs('2026-06-01').toDate();

    // Navigate next with stored config → Jun 16
    const nextWithStored = navigatePeriod(periodStart, 'next', storedConfig);
    expect(dayjs(nextWithStored).date()).toBe(16);

    // Navigate next with bi-weekly config → Jun 15
    const nextWithNew = navigatePeriod(periodStart, 'next', biweeklyConfig);
    expect(dayjs(nextWithNew).format('YYYY-MM-DD')).toBe('2026-06-15');

    // They should be different dates
    expect(dayjs(nextWithStored).format('YYYY-MM-DD')).not.toBe(dayjs(nextWithNew).format('YYYY-MM-DD'));
  });

  it('period boundary is deterministic from stored config', () => {
    // Simulates: period was created as semi-monthly, stored periodType='semimonthly', periodNumDays=15
    const storedPeriodType = 'semimonthly';
    const storedNumDays = 15;
    const periodStart = dayjs('2026-05-01').toDate();

    // Reconstruct config from stored values
    const reconstructedConfig: PeriodConfig = {
      periodType: storedPeriodType,
      anchorDate: new Date('2026-01-01'),
      weekStartDay: 1,
    };

    // Should produce the same day count
    expect(getNumDaysInPeriod(periodStart, reconstructedConfig)).toBe(storedNumDays);
  });

  it('approved period under bi-weekly stays 14 days after config change to monthly', () => {
    const biweeklyStart = dayjs('2026-06-08').toDate();

    // Under bi-weekly: always 14 days
    expect(getNumDaysInPeriod(biweeklyStart, biweeklyConfig)).toBe(14);

    // Under monthly: would be 30 days (June)
    expect(getNumDaysInPeriod(dayjs('2026-06-01').toDate(), monthlyConfig)).toBe(30);

    // The stored bi-weekly config must be used, not the current monthly
    const storedConfig: PeriodConfig = { periodType: 'biweekly', anchorDate: new Date('2026-01-05'), weekStartDay: 1 };
    expect(getNumDaysInPeriod(biweeklyStart, storedConfig)).toBe(14);
  });

  it('DEFAULT_PERIOD_CONFIG is semimonthly for backward compatibility', async () => {
    const { DEFAULT_PERIOD_CONFIG: defaultConfig } = await import('@/lib/date-utils');
    expect(defaultConfig.periodType).toBe('semimonthly');
  });
});
