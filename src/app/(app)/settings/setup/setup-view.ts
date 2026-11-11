import type { SetupPageData, SetupStep } from '@/server/internal/setup';
import type { SetupStepKey } from '@/lib/setup/steps';
import { DAY_NAMES } from '@/lib/timezone-options';
import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { formatCount } from '@/lib/format';

/**
 * The Setup checklist's words and rules (feature-plan-ux-setup-import.md §3.3). Pure, client-safe, unit-tested.
 */

export const PERIOD_OPTIONS = [
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'semimonthly', label: 'Twice a month (1st – 15th, 16th – end)' },
  { value: 'monthly', label: 'Once a month' },
] as const;
export type PeriodChoice = (typeof PERIOD_OPTIONS)[number]['value'];

/** Twice a month and once a month ignore the anchor and week start, which parseScheduleInput still requires. */
export const DEFAULT_ANCHOR = '2026-01-01';

const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** P5: the two settings steps show inline forms only while the step isn't done AND the workspace has no timesheet data. */
export function showsInlineForm(step: Pick<SetupStep, 'done'>, hasTimesheetData: boolean): boolean {
  return !step.done && !hasTimesheetData;
}

export function payScheduleSummary(c: { periodType: string; anchorDate: string; weekStartDay: number }): string {
  switch (c.periodType) {
    case 'weekly': return `Every week, starting ${DAY_NAMES[c.weekStartDay] ?? 'Monday'}`;
    case 'biweekly': return `Every two weeks, from ${formatCalendarDate(c.anchorDate as CalendarDate, 'MMM D, YYYY')}`;
    case 'monthly': return 'Once a month';
    default: return 'Twice a month (1st – 15th, 16th – end)';
  }
}

/** Each step's detail line (§3.1 table), built on the page from the loader's counts and settings. */
export function stepDetail(key: SetupStepKey, data: SetupPageData): string {
  const { counts } = data.status;
  const step = data.status.steps.find((s) => s.key === key);
  switch (key) {
    case 'timeAndWeek':
      // S10: the friendly name (e.g. "Eastern Time"), else the IANA id.
      return data.settings.workweekStartDay === null
        ? `${data.settings.timezoneLabel} · the workweek isn't set yet`
        : `${data.settings.timezoneLabel} · weeks start ${DAY_NAMES[data.settings.workweekStartDay]}`;
    case 'paySchedule':
      return data.settings.payConfig.set ? payScheduleSummary(data.settings.payConfig) : 'Using the default: twice a month';
    case 'contractsClins':
      return `${plural(counts.contracts, 'contract', 'contracts')} · ${plural(counts.clins, 'CLIN', 'CLINs')}`;
    case 'chargeCodes':
      return plural(counts.chargeCodes, 'direct code', 'direct codes');
    case 'people':
      return plural(counts.employees + counts.adminsWithAccess, 'person', 'people');
    case 'chargeCodeAccess':
      return `${formatCount(step?.withAccess ?? 0)} of ${formatCount(step?.total ?? 0)} people can charge a direct code`;
    case 'indirectCodes':
      return plural(counts.indirectCodes, 'code on every timesheet', 'codes on every timesheet');
    case 'laborCategories':
      return counts.laborCategories > 0 ? plural(counts.laborCategories, 'active category', 'active categories') : 'Needed to price hours on contract cost reports.';
    case 'connection':
      return data.settings.connectionName ?? 'QuickBooks Online or Gusto.';
  }
}

/** The charge-codes step's warn line, when active CLINs still have no code. */
export function clinsWithoutCodeWarning(data: SetupPageData): string | null {
  const k = data.status.counts.clinsWithoutCode;
  return k > 0 ? `${plural(k, 'CLIN has', 'CLINs have')} no code yet.` : null;
}

/** P3: the non-blocking note naming who can't charge a direct code (≤ 20 names, then "and {n} more"). */
export function accessGapNote(data: SetupPageData): string | null {
  const { missingCount, names } = data.gaps;
  if (missingCount === 0) return null;
  const more = missingCount - names.length;
  const who = more > 0 ? `${names.join(', ')} and ${formatCount(more)} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return `Without a direct code: ${who}. If they record only indirect time (overhead, G&A, leave), that's fine.`;
}

/** The first required step not done (it gets the "now" tint), or null. */
export function nowStep(steps: SetupStep[]): SetupStepKey | null {
  return steps.find((s) => s.required && !s.done)?.key ?? null;
}
