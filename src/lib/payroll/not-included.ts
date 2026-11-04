import type { CalendarDate } from '@/lib/calendar-date';

/**
 * A person-period that ISN'T in the payroll file (feature-plan-ux-approvals-payroll.md §4.1.2): its period isn't
 * approved. `status` is the stored row's, else `draft` with hours / `none` without. `partlyIncluded`: the person has an
 * approved in-range day in this file; `canReview`: submitted with a period row (the Approvals deep link). Pure (shared
 * by payroll-data and the Payroll export page).
 */
export interface NotIncluded {
  userId: string;
  employeeName: string;
  periodId: string | null;
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  status: 'none' | 'draft' | 'submitted' | 'rejected';
  hoursInRange: number;
  submittedAt: string | null;
  returnedAt: string | null;
  partlyIncluded: boolean;
  canReview: boolean;
}
