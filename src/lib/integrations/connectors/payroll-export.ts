import type { ConnectorMetadata, IntegrationConnector } from '../types';
import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { escapeCsvField } from '@/lib/csv/escape';
import { fromCents } from '@/lib/payroll/flsa';

// ---------------------------------------------------------------------------
// Connector Metadata
// ---------------------------------------------------------------------------

const metadata: ConnectorMetadata = {
  id: 'csv_export',
  name: 'Payroll Export',
  description: 'Download approved timesheet data as CSV files formatted for ADP, Paychex, Gusto, or custom payroll systems — FLSA weekly overtime.',
  icon: 'IconFileExport',
  color: 'orange',
  category: 'export',
  authType: 'file_export',
  requiredMappings: [],  // No mappings required — uses ByTime employee data directly
  capabilities: ['file_export'],
};

// ---------------------------------------------------------------------------
// Export formats (feature-plan-certified-outputs.md C7, CO-D2 / CO-D11 / CO-D14). Every hour figure comes from
// src/lib/payroll/flsa.ts (integer hundredths): Regular = regular WORKED hours only; leave in its own columns; vendor
// files carry no uncompensated-OT column (it lives in `custom` and the Daily hours detail). Vendor column names and
// earnings codes are this layout's best guess — verified against the vendors' import specs in staging.
// ---------------------------------------------------------------------------

export type PayrollFormat = 'adp' | 'paychex' | 'gusto' | 'custom';

export const FLSA_LABEL = 'FLSA weekly overtime';

/** One employee's reported totals (hundredths of an hour) — PayrollEmployee from payroll-data.ts. */
export interface PayrollRow {
  employeeName: string;
  employeeEmail: string;
  employeeId?: string;
  regular: number;
  overtime: number;
  uncompensatedOvertime: number;
  pto: number;
  sick: number;
  holiday: number;
  unpaidLeave: number;
  billable: number;
  totalPaid: number;
  totalRecorded: number;
}

export interface PayrollColumnContext {
  periodStart: string;
  periodEnd: string;
}

export interface PayrollColumn {
  key: string;
  header: string;
  getValue: (row: PayrollRow, ctx: PayrollColumnContext) => string;
}

export interface PayrollFormatConfig {
  id: PayrollFormat;
  name: string;
  description: string;
  fileExtension: string;
  delimiter: string;
  dateFormat: string;
  columns: PayrollColumn[];
}

const h = (cents: number) => fromCents(cents).toFixed(2);
const lastName = (r: PayrollRow) => r.employeeName.split(' ').slice(-1)[0] ?? '';
const firstName = (r: PayrollRow) => r.employeeName.split(' ')[0] ?? '';
const code = (cents: number, c: string) => (cents > 0 ? c : '');

export const PAYROLL_FORMATS: PayrollFormatConfig[] = [
  {
    id: 'adp',
    name: 'ADP Workforce Now',
    description: 'ADP payroll import: regular worked hours, FLSA weekly overtime, and PTO / sick / holiday in their own columns.',
    fileExtension: 'csv',
    delimiter: ',',
    dateFormat: 'MM/DD/YYYY',
    columns: [
      { key: 'employeeId', header: 'Employee ID', getValue: (r) => r.employeeId ?? r.employeeEmail },
      { key: 'lastName', header: 'Last Name', getValue: lastName },
      { key: 'firstName', header: 'First Name', getValue: firstName },
      { key: 'periodStart', header: 'Period Start', getValue: (_, c) => c.periodStart },
      { key: 'periodEnd', header: 'Period End', getValue: (_, c) => c.periodEnd },
      { key: 'regularHours', header: 'Regular Hours', getValue: (r) => h(r.regular) },
      { key: 'overtimeHours', header: 'OT Hours', getValue: (r) => h(r.overtime) },
      { key: 'ptoHours', header: 'PTO Hours', getValue: (r) => h(r.pto) },
      { key: 'sickHours', header: 'Sick Hours', getValue: (r) => h(r.sick) },
      { key: 'holidayHours', header: 'Holiday Hours', getValue: (r) => h(r.holiday) },
      // Paid hours only: Regular + OT + PTO + Sick + Holiday (no uncompensated OT, no unpaid leave).
      { key: 'totalHours', header: 'Total Hours', getValue: (r) => h(r.totalPaid) },
      { key: 'earningsCode', header: 'Earnings Code', getValue: () => 'REG' },
    ],
  },
  {
    id: 'paychex',
    name: 'Paychex Flex',
    description: 'Paychex payroll import: REG / OT / PTO / SICK / HOL hours with earnings codes.',
    fileExtension: 'csv',
    delimiter: ',',
    dateFormat: 'MM/DD/YYYY',
    columns: [
      { key: 'employeeId', header: 'Employee ID', getValue: (r) => r.employeeId ?? r.employeeEmail },
      { key: 'lastName', header: 'Last Name', getValue: lastName },
      { key: 'firstName', header: 'First Name', getValue: firstName },
      { key: 'payDate', header: 'Pay Date', getValue: (_, c) => c.periodEnd },
      { key: 'hours', header: 'Hours', getValue: (r) => h(r.regular) },
      { key: 'earningsCode', header: 'Earnings Code', getValue: () => 'REG' },
      { key: 'otHours', header: 'OT Hours', getValue: (r) => h(r.overtime) },
      { key: 'otEarningsCode', header: 'OT Earnings Code', getValue: (r) => code(r.overtime, 'OT') },
      { key: 'ptoHours', header: 'PTO Hours', getValue: (r) => h(r.pto) },
      { key: 'ptoEarningsCode', header: 'PTO Earnings Code', getValue: (r) => code(r.pto, 'PTO') },
      { key: 'sickHours', header: 'Sick Hours', getValue: (r) => h(r.sick) },
      { key: 'sickEarningsCode', header: 'Sick Earnings Code', getValue: (r) => code(r.sick, 'SICK') },
      { key: 'holidayHours', header: 'Holiday Hours', getValue: (r) => h(r.holiday) },
      { key: 'holidayEarningsCode', header: 'Holiday Earnings Code', getValue: (r) => code(r.holiday, 'HOL') },
    ],
  },
  {
    id: 'gusto',
    name: 'Gusto',
    description: 'Gusto bulk hours import — email-based employee matching; regular, overtime, PTO, sick and holiday hours.',
    fileExtension: 'csv',
    delimiter: ',',
    dateFormat: 'YYYY-MM-DD',
    columns: [
      { key: 'employeeEmail', header: 'employee_email', getValue: (r) => r.employeeEmail },
      { key: 'employeeName', header: 'employee_name', getValue: (r) => r.employeeName },
      { key: 'regularHours', header: 'regular_hours', getValue: (r) => h(r.regular) },
      { key: 'overtimeHours', header: 'overtime_hours', getValue: (r) => h(r.overtime) },
      { key: 'ptoHours', header: 'pto_hours', getValue: (r) => h(r.pto) },
      { key: 'sickHours', header: 'sick_hours', getValue: (r) => h(r.sick) },
      { key: 'holidayHours', header: 'holiday_hours', getValue: (r) => h(r.holiday) },
      { key: 'periodStart', header: 'pay_period_start', getValue: (_, c) => c.periodStart },
      { key: 'periodEnd', header: 'pay_period_end', getValue: (_, c) => c.periodEnd },
    ],
  },
  {
    id: 'custom',
    name: 'Custom Format',
    description: 'Every column: billable split, regular, FLSA overtime, uncompensated overtime, leave, total paid and total recorded.',
    fileExtension: 'csv',
    delimiter: ',',
    dateFormat: 'YYYY-MM-DD',
    columns: [
      { key: 'employeeName', header: 'Employee Name', getValue: (r) => r.employeeName },
      { key: 'employeeEmail', header: 'Email', getValue: (r) => r.employeeEmail },
      { key: 'billableHours', header: 'Billable Hours', getValue: (r) => h(r.billable) },
      { key: 'nonBillableHours', header: 'Non-Billable Hours', getValue: (r) => h(r.totalRecorded - r.billable) },
      { key: 'regularHours', header: 'Regular Hours (worked)', getValue: (r) => h(r.regular) },
      { key: 'overtimeHours', header: 'Overtime Hours (FLSA weekly)', getValue: (r) => h(r.overtime) },
      { key: 'uncompensatedOvertime', header: 'Uncompensated Overtime (exempt)', getValue: (r) => h(r.uncompensatedOvertime) },
      { key: 'ptoHours', header: 'PTO Hours', getValue: (r) => h(r.pto) },
      { key: 'sickHours', header: 'Sick Hours', getValue: (r) => h(r.sick) },
      { key: 'holidayHours', header: 'Holiday Hours', getValue: (r) => h(r.holiday) },
      { key: 'unpaidLeave', header: 'Unpaid Leave Hours', getValue: (r) => h(r.unpaidLeave) },
      { key: 'totalPaid', header: 'Total Paid Hours', getValue: (r) => h(r.totalPaid) },
      { key: 'totalRecorded', header: 'Total Recorded Hours', getValue: (r) => h(r.totalRecorded) },
      { key: 'periodStart', header: 'Period Start', getValue: (_, c) => c.periodStart },
      { key: 'periodEnd', header: 'Period End', getValue: (_, c) => c.periodEnd },
    ],
  },
];

// ---------------------------------------------------------------------------
// CSV generation
// ---------------------------------------------------------------------------

function csv(lines: string[][], delimiter: string): string {
  return lines.map((cells) => cells.map((v) => escapeCsvField(v, delimiter)).join(delimiter)).join('\n');
}

/** A vendor/custom payroll CSV for the range [periodStart, periodEnd]. */
export function generatePayrollCSV(rows: PayrollRow[], format: PayrollFormatConfig, periodStart: CalendarDate, periodEnd: CalendarDate): string {
  const ctx = { periodStart: formatCalendarDate(periodStart, format.dateFormat), periodEnd: formatCalendarDate(periodEnd, format.dateFormat) };
  return csv([format.columns.map((c) => c.header), ...rows.map((r) => format.columns.map((c) => c.getValue(r, ctx)))], format.delimiter);
}

export interface DailyDetailRow {
  employeeName: string;
  employeeEmail: string;
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
}

export const DAILY_DETAIL_HEADERS = [
  'Employee Name', 'Email', 'Date', 'Worked Hours', 'Regular Hours', 'Overtime Hours (FLSA weekly)',
  'Uncompensated Overtime (exempt)', 'PTO Hours', 'Sick Hours', 'Holiday Hours', 'Unpaid Leave Hours', 'Workweek Start',
];

/** The Daily hours detail CSV: one row per employee per reported date. */
export function generateDailyDetailCSV(days: DailyDetailRow[]): string {
  return csv([DAILY_DETAIL_HEADERS, ...days.map((d) => [
    d.employeeName, d.employeeEmail, d.date, h(d.worked), h(d.regular), h(d.overtime), h(d.uncompensatedOvertime),
    h(d.pto), h(d.sick), h(d.holiday), h(d.unpaidLeave), d.workweekStart,
  ])], ',');
}

/** "payroll-adp-flsa-weekly-overtime-2026-10-01-to-2026-10-15.csv" */
export function payrollFilename(kind: PayrollFormat | 'daily-hours', periodStart: CalendarDate, periodEnd: CalendarDate): string {
  return `payroll-${kind}-flsa-weekly-overtime-${periodStart}-to-${periodEnd}.csv`;
}

// ---------------------------------------------------------------------------
// Connector (catalog entry; the export itself runs through src/server/actions/payroll-export.ts)
// ---------------------------------------------------------------------------

export const payrollExportConnector: IntegrationConnector = {
  metadata,
};
