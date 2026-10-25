'use server';

import { getDb } from '@/db';
import { requireAdmin } from '@/lib/session';
import { userAction, type ActionResult } from '@/lib/action-result';
import {
  generateDailyDetailCSV,
  generatePayrollCSV,
  payrollFilename,
  PAYROLL_FORMATS,
  type PayrollFormat,
} from '@/lib/integrations/connectors/payroll-export';
import { fromCents } from '@/lib/payroll/flsa';
import type { CalendarDate } from '@/lib/calendar-date';
import { validateCalendarDate } from '@/lib/validation';
import { UserFacingError } from '@/lib/errors';
import { loadPayrollData, PayrollNotReadyError } from '@/server/internal/payroll-data';

/**
 * Payroll export — FLSA weekly overtime (feature-plan-certified-outputs.md C7). All figures come from
 * src/server/internal/payroll-data.ts + src/lib/payroll/flsa.ts. Admin-only reads (no write).
 */

export interface PayrollPreviewEmployee {
  employeeName: string;
  employeeEmail: string;
  flsaExempt: boolean;
  regularHours: number;
  overtimeHours: number;
  uncompensatedOvertimeHours: number;
  ptoHours: number;
  sickHours: number;
  holidayHours: number;
  unpaidLeaveHours: number;
  totalPaidHours: number;
  totalRecordedHours: number;
  /** The FLSA walk for a reported day used unapproved days earlier in the same workweek. */
  otBasisIncludesUnapprovedDays: boolean;
}

export type PayrollPreview =
  | { status: 'ready'; workweekStartDay: number; employees: PayrollPreviewEmployee[]; reportedDays: number }
  | { status: 'refused'; reason: 'workweek-unset' | 'leave-pay-type'; codes: string[]; message: string };

/**
 * Preview the export for a range: per-employee FLSA totals and the flagged employees — or why the export is refused
 * (workweek start day unset → Settings; leave codes without a pay type → Indirect Codes).
 */
export async function getPayrollExportPreview(data: {
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
}): Promise<ActionResult<PayrollPreview>> {
  return userAction(async () => {
    await requireAdmin();
    const db = await getDb();
    try {
      const payroll = await loadPayrollData(db, validateCalendarDate(data.periodStart, 'Start date'), validateCalendarDate(data.periodEnd, 'End date'));
      return {
        status: 'ready' as const,
        workweekStartDay: payroll.workweekStartDay,
        reportedDays: payroll.days.length,
        employees: payroll.employees.map((e) => ({
          employeeName: e.employeeName,
          employeeEmail: e.employeeEmail,
          flsaExempt: e.flsaExempt,
          regularHours: fromCents(e.regular),
          overtimeHours: fromCents(e.overtime),
          uncompensatedOvertimeHours: fromCents(e.uncompensatedOvertime),
          ptoHours: fromCents(e.pto),
          sickHours: fromCents(e.sick),
          holidayHours: fromCents(e.holiday),
          unpaidLeaveHours: fromCents(e.unpaidLeave),
          totalPaidHours: fromCents(e.totalPaid),
          totalRecordedHours: fromCents(e.totalRecorded),
          otBasisIncludesUnapprovedDays: e.otBasisIncludesUnapprovedDays,
        })),
      };
    } catch (err) {
      if (err instanceof PayrollNotReadyError) return { status: 'refused' as const, reason: err.reason, codes: err.codes, message: err.message };
      throw err;
    }
  });
}

/**
 * Generate a payroll export CSV (a vendor/custom format, or the Daily hours detail). The client handles the download.
 */
export async function generatePayrollExportCSV(data: {
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  format: PayrollFormat | 'daily-hours';
}): Promise<ActionResult<{ csvContent: string; filename: string; employeeCount: number; totalPaidHours: number; flaggedCount: number }>> {
  return userAction(async () => {
    await requireAdmin();
    const formatConfig = data.format === 'daily-hours' ? null : PAYROLL_FORMATS.find((f) => f.id === data.format);
    if (data.format !== 'daily-hours' && !formatConfig) throw new UserFacingError(`Unknown payroll format: ${data.format}`);
    const start = validateCalendarDate(data.periodStart, 'Start date');
    const end = validateCalendarDate(data.periodEnd, 'End date');
    const db = await getDb();
    const payroll = await loadPayrollData(db, start, end);
    const csvContent = formatConfig ? generatePayrollCSV(payroll.employees, formatConfig, start, end) : generateDailyDetailCSV(payroll.days);
    return {
      csvContent,
      filename: payrollFilename(data.format, start, end),
      employeeCount: payroll.employees.length,
      totalPaidHours: fromCents(payroll.employees.reduce((s, e) => s + e.totalPaid, 0)),
      flaggedCount: payroll.employees.filter((e) => e.otBasisIncludesUnapprovedDays).length,
    };
  });
}
