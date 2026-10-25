import { addDays, compare, dayOfWeek, isAfter, isBefore, type CalendarDate } from '@/lib/calendar-date';

/**
 * FLSA weekly overtime (feature-plan-certified-outputs.md C7, CO-D2 / CO-D11; docs/payroll-overtime-method.md).
 * Pure; every quantity is an integer number of HUNDREDTHS of an hour, so 40.00 h is exactly 4000 and never 3999.99….
 *
 * - Hours worked beyond the 40th in a workweek are overtime, on the day they occur (29 CFR 778.103–105). A workweek
 *   is the fixed 7 days starting on the workspace's workweek start day (0 = Sunday); each stands alone, and a week
 *   crossing pay periods or export ranges is ONE week.
 * - Leave of any kind (PTO, sick, holiday, unpaid) is never hours worked and never counts toward the 40
 *   (29 CFR 778.218–219). Unpaid leave is never in a paid column.
 * - Exempt employees: overtime is 0; the hours beyond 40 are reported as uncompensated overtime.
 * - The walk uses EVERY day given (so an unapproved day earlier in a workweek still counts toward its 40); only the
 *   days the caller marks `output` are reported. An employee is flagged when a reported day has overtime and
 *   unapproved worked hours earlier in the same workweek counted toward its 40.
 */

export const OVERTIME_THRESHOLD_CENTS = 4000;

export type HoursKind = 'worked' | 'pto' | 'sick' | 'holiday' | 'unpaid';

export interface FlsaEntry {
  userId: string;
  date: CalendarDate;
  kind: HoursKind;
  cents: number;
  /** Billable (direct) hours — reported alongside, not used by the FLSA walk. */
  billable: boolean;
}

export interface FlsaDayInfo {
  /** The date's containing period is approved (only such in-range days are reported). */
  approved: boolean;
}

export interface FlsaDay {
  userId: string;
  date: CalendarDate;
  workweekStart: CalendarDate;
  worked: number;
  regular: number;
  overtime: number;
  uncompensatedOvertime: number;
  pto: number;
  sick: number;
  holiday: number;
  unpaidLeave: number;
  billable: number;
}

export interface FlsaEmployeeTotals {
  userId: string;
  regular: number;
  overtime: number;
  uncompensatedOvertime: number;
  pto: number;
  sick: number;
  holiday: number;
  unpaidLeave: number;
  billable: number;
  /** All reported hours, worked + every leave kind (paid or not). */
  totalRecorded: number;
  /** Regular + overtime + PTO + sick + holiday (no uncompensated OT, no unpaid leave). */
  totalPaid: number;
  otBasisIncludesUnapprovedDays: boolean;
}

/** Hours (a numeric string or number) → integer hundredths. */
export function toCents(hours: string | number): number {
  const n = typeof hours === 'number' ? hours : parseFloat(hours);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export const fromCents = (cents: number): number => cents / 100;

/** The first day of the workweek containing `date`. */
export function workweekStart(date: CalendarDate, workweekStartDay: number): CalendarDate {
  return addDays(date, -((dayOfWeek(date) - workweekStartDay + 7) % 7));
}

export function computeFlsa(input: {
  entries: FlsaEntry[];
  exempt: (userId: string) => boolean;
  workweekStartDay: number;
  rangeStart: CalendarDate;
  rangeEnd: CalendarDate;
  dayInfo: (userId: string, date: CalendarDate) => FlsaDayInfo;
}): { days: FlsaDay[]; employees: FlsaEmployeeTotals[] } {
  const { workweekStartDay, rangeStart, rangeEnd } = input;
  type Bucket = { worked: number; pto: number; sick: number; holiday: number; unpaid: number; billable: number };
  const byUserDate = new Map<string, Map<CalendarDate, Bucket>>();
  for (const e of input.entries) {
    if (e.cents === 0) continue;
    let dates = byUserDate.get(e.userId);
    if (!dates) byUserDate.set(e.userId, (dates = new Map()));
    let b = dates.get(e.date);
    if (!b) dates.set(e.date, (b = { worked: 0, pto: 0, sick: 0, holiday: 0, unpaid: 0, billable: 0 }));
    if (e.kind === 'unpaid') b.unpaid += e.cents;
    else b[e.kind] += e.cents;
    if (e.billable) b.billable += e.cents;
  }

  const days: FlsaDay[] = [];
  const employees: FlsaEmployeeTotals[] = [];
  for (const userId of [...byUserDate.keys()].sort()) {
    const exempt = input.exempt(userId);
    const dates = byUserDate.get(userId)!;
    const totals: FlsaEmployeeTotals = {
      userId, regular: 0, overtime: 0, uncompensatedOvertime: 0, pto: 0, sick: 0, holiday: 0, unpaidLeave: 0,
      billable: 0, totalRecorded: 0, totalPaid: 0, otBasisIncludesUnapprovedDays: false,
    };
    let reported = false;
    let week: CalendarDate | null = null;
    let workedSoFar = 0;
    let unapprovedWorkedSoFar = 0;
    for (const date of [...dates.keys()].sort(compare)) {
      const wk = workweekStart(date, workweekStartDay);
      if (wk !== week) { week = wk; workedSoFar = 0; unapprovedWorkedSoFar = 0; }
      const b = dates.get(date)!;
      const regular = Math.min(b.worked, Math.max(0, OVERTIME_THRESHOLD_CENTS - workedSoFar));
      const beyond = b.worked - regular;
      const { approved } = input.dayInfo(userId, date);
      const inRange = !isBefore(date, rangeStart) && !isAfter(date, rangeEnd);
      if (inRange && approved) {
        reported = true;
        // Fix round 1 (F10): flag only when this day's OVERTIME depends on unapproved days earlier in the workweek.
        if (unapprovedWorkedSoFar > 0 && beyond > 0) totals.otBasisIncludesUnapprovedDays = true;
        const day: FlsaDay = {
          userId, date, workweekStart: wk, worked: b.worked, regular,
          overtime: exempt ? 0 : beyond, uncompensatedOvertime: exempt ? beyond : 0,
          pto: b.pto, sick: b.sick, holiday: b.holiday, unpaidLeave: b.unpaid, billable: b.billable,
        };
        days.push(day);
        totals.regular += day.regular;
        totals.overtime += day.overtime;
        totals.uncompensatedOvertime += day.uncompensatedOvertime;
        totals.pto += day.pto;
        totals.sick += day.sick;
        totals.holiday += day.holiday;
        totals.unpaidLeave += day.unpaidLeave;
        totals.billable += day.billable;
      }
      workedSoFar += b.worked;
      if (!approved) unapprovedWorkedSoFar += b.worked;
    }
    if (!reported) continue;
    totals.totalPaid = totals.regular + totals.overtime + totals.pto + totals.sick + totals.holiday;
    totals.totalRecorded = totals.regular + totals.overtime + totals.uncompensatedOvertime + totals.pto + totals.sick + totals.holiday + totals.unpaidLeave;
    employees.push(totals);
  }
  return { days, employees };
}
