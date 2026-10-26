import 'server-only';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { indirectChargeCodes, timesheetEntries, timesheetPeriods, users, workspaceSettings } from '@/db/schema';
import { addDays, isAfter, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';
import { computeFlsa, toCents, workweekStart, type FlsaDay, type FlsaEmployeeTotals, type FlsaEntry, type HoursKind } from '@/lib/payroll/flsa';
import { existingPeriodLength } from '@/server/internal/pay-period-config';

/**
 * Payroll data for the FLSA weekly-overtime exports and the Gusto payload (feature-plan-certified-outputs.md C7).
 *
 * Reads ALL latest-revision entries in [workweekStart(rangeStart), rangeEnd] regardless of approval — the FLSA walk
 * needs every worked day of a boundary workweek — with each entry's indirect category / leave pay type and each
 * date's containing period. Only in-range dates whose containing period is APPROVED are reported (a period that
 * started before the range contributes its in-range days). Refuses while the workweek start day is unset or a leave
 * code used in the range has no pay type.
 */

export const WORKWEEK_UNSET_MESSAGE =
  'Set the workweek start day in Settings before exporting payroll — FLSA weekly overtime is computed per workweek.';

export class PayrollNotReadyError extends UserFacingError {
  constructor(readonly reason: 'workweek-unset' | 'leave-pay-type', readonly codes: string[] = []) {
    super(reason === 'workweek-unset'
      ? WORKWEEK_UNSET_MESSAGE
      : `Set a pay type (PTO, sick, holiday or unpaid) on these leave codes in Indirect Codes before exporting payroll: ${codes.join(', ')}.`);
    this.name = 'PayrollNotReadyError';
  }
}

export interface PayrollEmployee extends FlsaEmployeeTotals {
  employeeName: string;
  employeeEmail: string;
  flsaExempt: boolean;
}

export interface PayrollDay extends FlsaDay {
  employeeName: string;
  employeeEmail: string;
}

export interface PayrollData {
  rangeStart: CalendarDate;
  rangeEnd: CalendarDate;
  workweekStartDay: number;
  employees: PayrollEmployee[];
  days: PayrollDay[];
}

/** The workspace's workweek start day (0 = Sunday … 6), or null while unset. */
export async function readWorkweekStartDay(db: Pick<ReadDb, 'select'>): Promise<number | null> {
  const [row] = await db.select({ day: workspaceSettings.workweekStartDay }).from(workspaceSettings).limit(1);
  return row?.day ?? null;
}

/** Throws PayrollNotReadyError('workweek-unset') when the setting is missing; else returns it. */
export async function requireWorkweekStartDay(db: Pick<ReadDb, 'select'>): Promise<number> {
  const day = await readWorkweekStartDay(db);
  if (day === null) throw new PayrollNotReadyError('workweek-unset');
  return day;
}

const LEAVE_KINDS: Record<string, HoursKind> = { pto: 'pto', sick: 'sick', holiday: 'holiday', unpaid: 'unpaid' };

export async function loadPayrollData(db: Pick<ReadDb, 'select'>, rangeStart: CalendarDate, rangeEnd: CalendarDate): Promise<PayrollData> {
  if (isAfter(rangeStart, rangeEnd)) throw new UserFacingError('The start date must be on or before the end date.');
  const workweekStartDay = await requireWorkweekStartDay(db);
  const from = workweekStart(rangeStart, workweekStartDay);

  const rows = await db
    .select({
      userId: timesheetEntries.userId,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      clinId: timesheetEntries.clinId,
      indirectCode: indirectChargeCodes.code,
      indirectCategory: indirectChargeCodes.category,
      leavePayType: indirectChargeCodes.leavePayType,
    })
    .from(timesheetEntries)
    .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
    .where(and(
      gte(timesheetEntries.entryDate, from),
      lte(timesheetEntries.entryDate, rangeEnd),
      eq(
        timesheetEntries.revisionNumber,
        sql`(
          SELECT MAX(te2.revision_number)
          FROM timesheet_entries te2
          WHERE te2.user_id = ${timesheetEntries.userId}
            AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
            AND te2.entry_date = ${timesheetEntries.entryDate}
        )`,
      ),
    ));

  // Refuse while a leave code with hours in the range has no pay type (CO-D11/CO-D16: only custom codes can block).
  const missing = [...new Set(rows
    .filter((r) => r.indirectCategory === 'leave' && !r.leavePayType && toCents(r.hours) !== 0
      && !isBefore(r.entryDate as CalendarDate, rangeStart))
    .map((r) => r.indirectCode ?? '?'))].sort();
  if (missing.length > 0) throw new PayrollNotReadyError('leave-pay-type', missing);

  const userIds = [...new Set(rows.map((r) => r.userId))];
  if (userIds.length === 0) return { rangeStart, rangeEnd, workweekStartDay, employees: [], days: [] };

  const people = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email, flsaExempt: users.flsaExempt })
    .from(users).where(inArray(users.id, userIds));
  const person = new Map(people.map((p) => [p.id, p]));

  // Each date's containing period (no period is longer than 31 days).
  const periodRows = await db
    .select({ userId: timesheetPeriods.userId, periodStart: timesheetPeriods.periodStart, periodNumDays: timesheetPeriods.periodNumDays, status: timesheetPeriods.status })
    .from(timesheetPeriods)
    .where(and(inArray(timesheetPeriods.userId, userIds), gte(timesheetPeriods.periodStart, addDays(from, -31)), lte(timesheetPeriods.periodStart, rangeEnd)));
  const periods = new Map<string, Array<{ start: CalendarDate; endExclusive: CalendarDate; approved: boolean }>>();
  for (const p of periodRows) {
    const start = p.periodStart as CalendarDate;
    const numDays = await existingPeriodLength(db, start, p.periodNumDays);
    const list = periods.get(p.userId) ?? [];
    list.push({ start, endExclusive: addDays(start, numDays), approved: p.status === 'approved' });
    periods.set(p.userId, list);
  }
  const approvedOn = (userId: string, date: CalendarDate) =>
    (periods.get(userId) ?? []).some((p) => p.approved && !isBefore(date, p.start) && isBefore(date, p.endExclusive));

  const entries: FlsaEntry[] = rows.map((r) => ({
    userId: r.userId,
    date: r.entryDate as CalendarDate,
    kind: r.indirectCategory === 'leave' ? LEAVE_KINDS[r.leavePayType ?? ''] ?? 'unpaid' : 'worked',
    cents: toCents(r.hours),
    billable: r.clinId !== null,
  }));

  const result = computeFlsa({
    entries,
    exempt: (id) => person.get(id)?.flsaExempt ?? false,
    workweekStartDay,
    rangeStart,
    rangeEnd,
    dayInfo: (id, date) => ({ approved: approvedOn(id, date) }),
  });

  const named = <T extends { userId: string }>(x: T) => ({ ...x, employeeName: person.get(x.userId)?.fullName ?? '', employeeEmail: person.get(x.userId)?.email ?? '' });
  const employees = result.employees
    .map((e) => ({ ...named(e), flsaExempt: person.get(e.userId)?.flsaExempt ?? false }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.userId.localeCompare(b.userId));
  const order = new Map(employees.map((e, i) => [e.userId, i]));
  const days = result.days.map(named).sort((a, b) => (order.get(a.userId)! - order.get(b.userId)!) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rangeStart, rangeEnd, workweekStartDay, employees, days };
}
