import type { CalendarDate } from '@/lib/calendar-date';
import type { ChargeCode, TimesheetPageData, TimesheetPeriodData } from '@/types/timesheet';

/**
 * Timesheet test fixtures in the feature-plan-ux-timesheet-ui.md §4.4 shape: `{ ...pageContext, period }`, where `period`
 * is a whole getTimesheetPeriod result. Defaults: the semi-monthly period Jan 1–15, 2026, today Jan 20 (all days past).
 */

export const CC = '22222222-2222-4222-8222-222222222222';
export const CC2 = '33333333-3333-4333-8333-333333333333';
export const IND = '44444444-4444-4444-8444-444444444444';

export const chargeCode = (o: Partial<ChargeCode> = {}): ChargeCode => ({
  id: CC, projectName: 'Navy', clin: 'NAV-1', description: 'Code 1', name: 'Code 1', kind: 'charge', assignable: true, ...o,
});

export function periodData(o: Partial<TimesheetPeriodData> = {}): TimesheetPeriodData {
  const periodStart = (o.periodStart ?? '2026-01-01') as CalendarDate;
  const numDays = o.numDays ?? 15;
  const chargeCodes = o.chargeCodes ?? [chargeCode()];
  return {
    periodStart,
    isCurrent: false,
    numDays,
    periodConfig: { periodType: 'semimonthly', anchorDate: '2026-01-01' as CalendarDate, weekStartDay: 1 },
    entries: chargeCodes.map((c) => ({ chargeCodeId: c.id, hours: Array(numDays).fill(0) })),
    revisions: {},
    periodStatus: 'draft',
    approvalBadge: null,
    chargeCodes,
    notes: {},
    reviewComment: null,
    summary: {
      periodStart, periodEnd: periodStart, periodLabel: '', status: 'draft', submittedAt: null, reviewedAt: null, reviewComment: null,
      totalHoursEntered: 0, expectedWorkdays: 0, daysWithEntries: 0, workdaysFilled: 0, daysRemaining: 0, submissionDeadline: '',
      canSubmitToday: false, dailyHours: {},
    },
    submitOpensOn: '2026-01-15' as CalendarDate,
    workweekStartDay: null,
    outsideWeekHours: {},
    userCreatedOn: '2025-01-01' as CalendarDate,
    submittedOn: null,
    reviewedOn: null,
    today: '2026-01-20' as CalendarDate,
    readOnly: false,
    ...o,
  };
}

export function pageData(period: Partial<TimesheetPeriodData> = {}, page: Partial<Omit<TimesheetPageData, 'period'>> = {}): TimesheetPageData {
  const p = periodData(period);
  return { userId: 'u1', today: p.today, readOnly: p.readOnly, flsaExempt: false, ...page, period: p };
}
