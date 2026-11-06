import 'server-only';
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { indirectChargeCodes, timesheetEntries, timesheetPeriods, users, workspaceSettings } from '@/db/schema';
import { addDays, calendarDayOf, canonicalTimeZone, isAfter, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';
import { computeFlsa, toCents, workweekStart, type FlsaDay, type FlsaEmployeeTotals, type FlsaEntry, type HoursKind } from '@/lib/payroll/flsa';
import { loadScheduleResolver } from '@/server/internal/pay-period-config';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import { EXPECTED_SUBMITTER_ROLES } from '@/server/internal/team-period-status';
import type { NotIncluded } from '@/lib/payroll/not-included';

export type { NotIncluded };

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
  /** UX-4b Part 2 §4.1: who isn't in this file and why (the expected set; never changes employees / days). */
  notIncluded: NotIncluded[];
}

/** The workspace's workweek start day (0 = Sunday … 6, null while unset) and timezone, in one read. */
async function readWorkweekSettings(db: Pick<ReadDb, 'select'>): Promise<{ day: number | null; timezone: string }> {
  const [row] = await db.select({ day: workspaceSettings.workweekStartDay, timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
  return { day: row?.day ?? null, timezone: canonicalTimeZone(row?.timezone) ?? 'America/New_York' };
}

/** The workspace's workweek start day (0 = Sunday … 6), or null while unset. */
export async function readWorkweekStartDay(db: Pick<ReadDb, 'select'>): Promise<number | null> {
  return (await readWorkweekSettings(db)).day;
}

/** Throws PayrollNotReadyError('workweek-unset') when the setting is missing; else returns it. */
export async function requireWorkweekStartDay(db: Pick<ReadDb, 'select'>): Promise<number> {
  const day = await readWorkweekStartDay(db);
  if (day === null) throw new PayrollNotReadyError('workweek-unset');
  return day;
}

const STATUS_ORDER: Record<NotIncluded['status'], number> = { submitted: 0, rejected: 1, draft: 2, none: 3 };

const LEAVE_KINDS: Record<string, HoursKind> = { pto: 'pto', sick: 'sick', holiday: 'holiday', unpaid: 'unpaid' };

export async function loadPayrollData(db: Pick<ReadDb, 'select'>, rangeStart: CalendarDate, rangeEnd: CalendarDate): Promise<PayrollData> {
  if (isAfter(rangeStart, rangeEnd)) throw new UserFacingError('The start date must be on or before the end date.');
  const settings = await readWorkweekSettings(db);
  if (settings.day === null) throw new PayrollNotReadyError('workweek-unset');
  const workweekStartDay = settings.day;
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

  // §4.1.1: every entry user (names and exemption for the file, exactly as before) OR an expected submitter (for
  // "not in this file") — no early return, so an empty range still lists the people who are expected.
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const expectedRoles = EXPECTED_SUBMITTER_ROLES as readonly string[];
  const people = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email, flsaExempt: users.flsaExempt, isActive: users.isActive, role: users.role, createdAt: users.createdAt })
    .from(users)
    .where(or(
      userIds.length > 0 ? inArray(users.id, userIds) : undefined,
      and(eq(users.isActive, true), inArray(users.role, [...expectedRoles] as Array<'employee' | 'supervisor' | 'admin'>)),
    ));
  const person = new Map(people.map((p) => [p.id, p]));
  const personIds = people.map((p) => p.id);

  // Each date's containing period (no period is longer than 31 days), and the schedule for rows without a snapshot.
  const [periodRows, resolver] = await Promise.all([
    personIds.length === 0 ? Promise.resolve([]) : db
      .select({
        id: timesheetPeriods.id, userId: timesheetPeriods.userId, periodStart: timesheetPeriods.periodStart, periodNumDays: timesheetPeriods.periodNumDays,
        status: timesheetPeriods.status, submittedAt: timesheetPeriods.submittedAt, reviewedAt: timesheetPeriods.reviewedAt,
      })
      .from(timesheetPeriods)
      .where(and(inArray(timesheetPeriods.userId, personIds), gte(timesheetPeriods.periodStart, addDays(from, -31)), lte(timesheetPeriods.periodStart, rangeEnd))),
    loadScheduleResolver(db as Parameters<typeof loadScheduleResolver>[0]),
  ]);
  type StoredPeriod = { id: string; start: CalendarDate; endExclusive: CalendarDate; status: string; submittedAt: Date | null; reviewedAt: Date | null };
  const periods = new Map<string, StoredPeriod[]>();
  for (const p of periodRows) {
    const start = p.periodStart as CalendarDate;
    // The row's own snapshot (a positive one, as existingPeriodLength — fix round 1, L1), else its length under the
    // schedule in effect on its start — never a snapped period, so a misaligned imported row keeps exactly the approved
    // days it had before (P-5).
    const numDays = p.periodNumDays != null && p.periodNumDays > 0 ? p.periodNumDays : getNumDaysInPeriod(start, resolver.configOn(start));
    const list = periods.get(p.userId) ?? [];
    list.push({ id: p.id, start, endExclusive: addDays(start, numDays), status: p.status, submittedAt: p.submittedAt, reviewedAt: p.reviewedAt });
    periods.set(p.userId, list);
  }
  const approvedOn = (userId: string, date: CalendarDate) =>
    (periods.get(userId) ?? []).some((p) => p.status === 'approved' && !isBefore(date, p.start) && isBefore(date, p.endExclusive));

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

  const notIncluded = notIncludedRows({
    people, periods, rows, rangeStart, rangeEnd, resolver, timeZone: settings.timezone,
    reported: new Set(result.days.map((x) => x.userId)), expectedRoles,
  });
  return { rangeStart, rangeEnd, workweekStartDay, employees, days, notIncluded };
}

/**
 * §4.1.2: per person, the person-periods in range that aren't approved. Stored rows cover their own days first; the
 * remaining in-range days are grouped by the schedule's period — one overlapping a stored row is never listed whole,
 * only its uncovered days with hours, as one draft clipped to them (fix round 1, M4). A person-period
 * with no row and no hours is listed only for an expected submitter created on or before the period's end (the
 * createdAt rule never hides a stored row or recorded hours). Ordered by status, name, period start.
 */
function notIncludedRows(input: {
  people: Array<{ id: string; fullName: string; isActive: boolean; role: string; createdAt: Date }>;
  periods: Map<string, Array<{ id: string; start: CalendarDate; endExclusive: CalendarDate; status: string; submittedAt: Date | null; reviewedAt: Date | null }>>;
  rows: Array<{ userId: string; entryDate: string; hours: string }>;
  rangeStart: CalendarDate;
  rangeEnd: CalendarDate;
  resolver: Awaited<ReturnType<typeof loadScheduleResolver>>;
  timeZone: string;
  reported: Set<string>;
  expectedRoles: readonly string[];
}): NotIncluded[] {
  const { people, periods, rows, rangeStart, rangeEnd, resolver, timeZone, reported, expectedRoles } = input;
  const inRange = (d: CalendarDate) => !isBefore(d, rangeStart) && !isAfter(d, rangeEnd);
  const centsOn = new Map<string, number>(); // `${userId}|${date}` → latest-revision cents, all kinds
  for (const r of rows) {
    const day = r.entryDate as CalendarDate;
    if (!inRange(day)) continue;
    const k = `${r.userId}|${day}`;
    centsOn.set(k, (centsOn.get(k) ?? 0) + toCents(r.hours));
  }
  const days: CalendarDate[] = [];
  for (let d = rangeStart; !isAfter(d, rangeEnd); d = addDays(d, 1)) days.push(d);

  const out: NotIncluded[] = [];
  for (const p of people) {
    const expected = p.isActive && expectedRoles.includes(p.role);
    const stored = periods.get(p.id) ?? [];
    const hoursIn = (start: CalendarDate, endExclusive: CalendarDate) =>
      days.filter((d) => !isBefore(d, start) && isBefore(d, endExclusive)).reduce((s, d) => s + (centsOn.get(`${p.id}|${d}`) ?? 0), 0);
    const push = (o: Omit<NotIncluded, 'userId' | 'employeeName' | 'partlyIncluded' | 'canReview'>) =>
      out.push({ userId: p.id, employeeName: p.fullName, ...o, partlyIncluded: reported.has(p.id), canReview: o.status === 'submitted' && o.periodId !== null });

    // 1. Stored rows overlapping the range (approved ones aren't listed; their days are still covered).
    for (const row of stored) {
      const end = addDays(row.endExclusive, -1);
      if (isAfter(row.start, rangeEnd) || isBefore(end, rangeStart) || row.status === 'approved') continue;
      const cents = hoursIn(row.start, row.endExclusive);
      push({
        periodId: row.id, periodStart: row.start, periodEnd: end,
        status: row.status === 'submitted' || row.status === 'rejected' ? row.status : 'draft',
        hoursInRange: cents / 100,
        submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
        returnedAt: row.status === 'rejected' && row.reviewedAt ? row.reviewedAt.toISOString() : null,
      });
    }
    // 2. The remaining in-range days, by the schedule's period — never a period overlapping a stored row.
    const covered = (d: CalendarDate) => stored.some((r) => !isBefore(d, r.start) && isBefore(d, r.endExclusive));
    const seen = new Set<string>();
    for (const d of days) {
      if (covered(d)) continue;
      const sp = resolver.periodContaining(d);
      if (seen.has(sp.start)) continue;
      seen.add(sp.start);
      const endExclusive = addDays(sp.start, sp.numDays);
      if (stored.some((r) => isBefore(r.start, endExclusive) && isBefore(sp.start, r.endExclusive))) {
        // M4: a stored row overlaps this period (a schedule change, a misaligned import). Its uncovered in-range days
        // with hours are still not in the file: one draft row clipped to those days; none without hours.
        const uncovered = days.filter((x) => !isBefore(x, sp.start) && isBefore(x, endExclusive) && !covered(x));
        const clipped = uncovered.reduce((s, x) => s + (centsOn.get(`${p.id}|${x}`) ?? 0), 0);
        if (clipped > 0) {
          push({ periodId: null, periodStart: uncovered[0], periodEnd: uncovered[uncovered.length - 1], status: 'draft', hoursInRange: clipped / 100, submittedAt: null, returnedAt: null });
        }
        continue;
      }
      const periodEnd = addDays(sp.start, sp.numDays - 1);
      const cents = hoursIn(sp.start, endExclusive);
      if (cents === 0 && !(expected && !isAfter(calendarDayOf(p.createdAt, timeZone), periodEnd))) continue;
      push({ periodId: null, periodStart: sp.start, periodEnd, status: cents > 0 ? 'draft' : 'none', hoursInRange: cents / 100, submittedAt: null, returnedAt: null });
    }
  }
  return out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || a.employeeName.localeCompare(b.employeeName) || (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0));
}
