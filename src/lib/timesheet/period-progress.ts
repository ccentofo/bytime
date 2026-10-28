import { addDays, dayOfWeek, isAfter, type CalendarDate } from '@/lib/calendar-date';

/**
 * A pay period's progress (feature-plan-ux-timesheet-ui.md §4.4). Pure and client-safe: the server's
 * currentPeriodSummary and the timesheet screen (from its working entries, unsaved edits included) use the same rule.
 */

export interface PeriodProgress {
  /** Hours across all rows and days, rounded to 2 decimals. */
  total: number;
  /** Mon–Fri days up to and including today with a day total above 0. */
  workdaysFilled: number;
  /** Mon–Fri days in the period up to and including today. */
  expectedWorkdays: number;
  /** When Submit opens (the period's last weekday): the due date. */
  dueDate: CalendarDate;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isWeekday = (d: CalendarDate) => { const dow = dayOfWeek(d); return dow >= 1 && dow <= 5; };

export function periodProgress(input: {
  start: CalendarDate;
  numDays: number;
  /** 'YYYY-MM-DD' → that day's total across all rows (missing = 0). */
  dailyHours: Record<string, number>;
  today: CalendarDate;
  submitOpensOn: CalendarDate;
}): PeriodProgress {
  let total = 0;
  let workdaysFilled = 0;
  let expectedWorkdays = 0;
  for (let i = 0; i < input.numDays; i++) {
    const day = addDays(input.start, i);
    const hours = input.dailyHours[day] ?? 0;
    total += hours;
    if (!isWeekday(day) || isAfter(day, input.today)) continue;
    expectedWorkdays++;
    if (hours > 0) workdaysFilled++;
  }
  return { total: round2(total), workdaysFilled, expectedWorkdays, dueDate: input.submitOpensOn };
}

/** Day totals ('YYYY-MM-DD' → hours) across rows, from per-row hour arrays indexed by period day. */
export function dailyTotalsOf(start: CalendarDate, numDays: number, rows: Array<{ hours: number[] }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < numDays; i++) {
    let sum = 0;
    for (const r of rows) sum += r.hours[i] ?? 0;
    out[addDays(start, i)] = round2(sum);
  }
  return out;
}
