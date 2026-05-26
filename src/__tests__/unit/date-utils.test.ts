import { describe, it, expect, vi } from 'vitest';
import { getNumDaysInPeriod, getCurrentPeriodStart, navigatePeriod } from '@/lib/date-utils';
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
