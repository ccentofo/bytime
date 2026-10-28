import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { dailyTotalsOf, periodProgress } from '@/lib/timesheet/period-progress';
import type { CalendarDate } from '@/lib/calendar-date';

/**
 * feature-plan-ux-timesheet-ui.md B-T15 (§4.4): one progress rule for the server summary (Home, T21) and the screen —
 * weekends and future days excluded from the workday counts, totals across rows, dueDate = submitOpensOn, rounding.
 */

const D = (s: string) => s as CalendarDate;
// Oct 1–15, 2026: Oct 1 is a Thursday; weekends Oct 3–4 and 10–11.
const base = { start: D('2026-10-01'), numDays: 15, submitOpensOn: D('2026-10-15') };

describe('periodProgress (B-T15)', () => {
  it('weekends and days after today are excluded from the workday counts; the total counts every day', () => {
    const p = periodProgress({ ...base, today: D('2026-10-07'), dailyHours: { '2026-10-01': 8, '2026-10-02': 0, '2026-10-03': 4, '2026-10-05': 5, '2026-10-09': 8 } });
    expect(p).toEqual({ total: 25, workdaysFilled: 2, expectedWorkdays: 5, dueDate: '2026-10-15' }); // Oct 1, 2, 5, 6, 7 expected; 1 and 5 filled
  });

  it('dueDate is submitOpensOn; a missing day is 0; days outside the period are ignored', () => {
    const p = periodProgress({ ...base, submitOpensOn: D('2026-10-14'), today: D('2026-10-31'), dailyHours: { '2026-09-30': 9, '2026-10-16': 9 } });
    expect(p).toEqual({ total: 0, workdaysFilled: 0, expectedWorkdays: 11, dueDate: '2026-10-14' });
  });

  it('totals across rows (dailyTotalsOf) and rounding to 2 decimals', () => {
    const daily = dailyTotalsOf(D('2026-10-01'), 3, [{ hours: [0.1, 2.25, 0] }, { hours: [0.2, 0.25, 0] }]);
    expect(daily).toEqual({ '2026-10-01': 0.3, '2026-10-02': 2.5, '2026-10-03': 0 });
    expect(periodProgress({ start: D('2026-10-01'), numDays: 3, submitOpensOn: D('2026-10-02'), today: D('2026-10-03'), dailyHours: { '2026-10-01': 0.1, '2026-10-02': 0.2 } }).total).toBe(0.3);
  });

  it('currentPeriodSummary uses it (static) — Home / T21 keep their fields and the submissionDeadline format', () => {
    const src = readFileSync(path.resolve(__dirname, '../../server/internal/employee-dashboard.ts'), 'utf8');
    expect(src).toContain("import { periodProgress } from '@/lib/timesheet/period-progress';");
    expect(src).toMatch(/const progress = periodProgress\(\{ start, numDays: period\.numDays, dailyHours, today, submitOpensOn: lastWeekday \}\);/);
    expect(src).toMatch(/totalHoursEntered: progress\.total,/);
    expect(src).toMatch(/expectedWorkdays: progress\.expectedWorkdays,/);
    expect(src).toMatch(/workdaysFilled: progress\.workdaysFilled,/);
    expect(src).toMatch(/submissionDeadline: formatCalendarDate\(lastWeekday, 'MMM D, YYYY'\),/);
  });
});
