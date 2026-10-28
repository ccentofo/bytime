import { describe, it, expect } from 'vitest';
import { outsideWeekDates, weeklyTotals, weeksUnder40, workweekStartOf } from '@/lib/timesheet/weekly';
import { addDays, type CalendarDate } from '@/lib/calendar-date';

/**
 * feature-plan-ux-timesheet.md A-T8 (A4.6): workweek totals follow the workspace workweek, complete the period's edge
 * weeks from outsideWeekHours, never flag an incomplete (future or unknown) week, and report overtime per complete week.
 */

const days = (start: string, n: number) => Array.from({ length: n }, (_, i) => addDays(start as CalendarDate, i));
// Oct 2026: Oct 1 is a Thursday; the semi-monthly period Oct 1–15.
const PERIOD = days('2026-10-01', 15);
const eight = (dates: CalendarDate[]) => Object.fromEntries(dates.filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())).map((d) => [d, 8]));

describe('workweekStartOf / outsideWeekDates', () => {
  it('Monday vs Sunday workweeks (null = Sunday)', () => {
    expect(workweekStartOf('2026-10-01' as CalendarDate, 1)).toBe('2026-09-28');
    expect(workweekStartOf('2026-10-01' as CalendarDate, 0)).toBe('2026-09-27');
    expect(workweekStartOf('2026-10-01' as CalendarDate, null)).toBe('2026-09-27');
    expect(workweekStartOf('2026-09-28' as CalendarDate, 1)).toBe('2026-09-28');
  });

  it('the days of the first and last workweeks outside the period', () => {
    // Monday workweek: Sep 28–30 before; Oct 16–18 after (Oct 15 is a Thursday, week Oct 12–18).
    expect(outsideWeekDates('2026-10-01' as CalendarDate, 15, 1)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-16', '2026-10-17', '2026-10-18']);
    // Sunday workweek: Sep 27–30 before; Oct 16–17 after.
    expect(outsideWeekDates('2026-10-01' as CalendarDate, 15, null)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-16', '2026-10-17']);
    // A period that starts on the workweek start and ends on its last day has none.
    expect(outsideWeekDates('2026-10-05' as CalendarDate, 14, 1)).toEqual([]);
  });
});

describe('weeklyTotals (A-T8)', () => {
  const TODAY = '2026-10-31' as CalendarDate; // every week below is in the past

  it('Monday workweek: three weeks; the edge weeks are completed by outsideWeekHours, so a full week isn\'t "under 40"', () => {
    const outside = { '2026-09-28': 8, '2026-09-29': 8, '2026-09-30': 8, '2026-10-16': 8, '2026-10-17': 0, '2026-10-18': 0 };
    const weeks = weeklyTotals(PERIOD, eight(PERIOD), outside, 1, TODAY);
    expect(weeks.map((w) => [w.weekStart, w.total, w.complete])).toEqual([['2026-09-28', 40, true], ['2026-10-05', 40, true], ['2026-10-12', 40, true]]);
    expect(weeksUnder40(weeks)).toEqual([]);
  });

  it('without the outside hours an edge week is unknown → incomplete → never flagged (the old Sunday–Saturday clip did flag it)', () => {
    const weeks = weeklyTotals(PERIOD, eight(PERIOD), {}, 1, TODAY);
    expect(weeks[0]).toMatchObject({ weekStart: '2026-09-28', total: 16, complete: false, overtime: 0 });
    expect(weeksUnder40(weeks)).toEqual([]);
  });

  it('Sunday workweek groups differently from Monday', () => {
    const outside = { '2026-09-27': 0, '2026-09-28': 8, '2026-09-29': 8, '2026-09-30': 8, '2026-10-16': 8, '2026-10-17': 0 };
    const weeks = weeklyTotals(PERIOD, eight(PERIOD), outside, 0, TODAY);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-09-27', '2026-10-04', '2026-10-11']);
  });

  it('a week that ends after today is incomplete and not flagged, however few hours it has', () => {
    const weeks = weeklyTotals(PERIOD, { '2026-10-12': 4 }, { '2026-10-16': 0, '2026-10-17': 0, '2026-10-18': 0 }, 1, '2026-10-14' as CalendarDate);
    expect(weeks[2]).toMatchObject({ weekStart: '2026-10-12', total: 4, complete: false, overtime: 0 });
    // An incomplete week reports no overtime, even past 40 hours.
    expect(weeklyTotals(PERIOD, { '2026-10-12': 24, '2026-10-13': 24, '2026-10-14': 4 }, {}, 1, '2026-10-14' as CalendarDate)[2]).toMatchObject({ total: 52, complete: false, overtime: 0 });
    expect(weeksUnder40(weeks).map((w) => w.weekStart)).not.toContain('2026-10-12');
  });

  it('overtime per complete week: max(0, total − 40)', () => {
    const hours = { ...eight(PERIOD), '2026-10-10': 6 }; // Saturday in the middle week
    const weeks = weeklyTotals(PERIOD, hours, { '2026-09-28': 8, '2026-09-29': 8, '2026-09-30': 8, '2026-10-16': 8, '2026-10-17': 0, '2026-10-18': 0 }, 1, TODAY);
    expect(weeks.map((w) => w.overtime)).toEqual([0, 6, 0]);
    expect(weeksUnder40(weeklyTotals(PERIOD, { '2026-10-05': 8 }, {}, 1, TODAY)).map((w) => w.weekStart)).toEqual(['2026-10-05']);
  });
});
