import type {
  IntegrationConnector,
  ConnectorMetadata,
  TimesheetSyncEntry,
} from '../types';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Connector Metadata
// ---------------------------------------------------------------------------

const metadata: ConnectorMetadata = {
  id: 'csv_export',
  name: 'Payroll Export',
  description: 'Download approved timesheet data as CSV files formatted for ADP, Paychex, Gusto, or custom payroll systems.',
  icon: 'IconFileExport',
  color: 'orange',
  category: 'export',
  authType: 'file_export',
  requiredMappings: [],  // No mappings required — uses ByTime employee data directly
  capabilities: ['file_export'],
};

// ---------------------------------------------------------------------------
// Export Format Types
// ---------------------------------------------------------------------------

export type PayrollFormat = 'adp' | 'paychex' | 'gusto' | 'custom';

export interface PayrollFormatConfig {
  id: PayrollFormat;
  name: string;
  description: string;
  fileExtension: string;
  delimiter: string;
  dateFormat: string;
  columns: PayrollColumn[];
}

export interface PayrollColumn {
  key: string;
  header: string;
  getValue: (row: AggregatedEmployeeHours) => string;
}

export interface AggregatedEmployeeHours {
  employeeName: string;
  employeeEmail: string;
  employeeId?: string;         // Optional payroll system ID (from mapping)
  totalHours: number;
  regularHours: number;        // Capped at 80 per semi-monthly period (or configurable)
  overtimeHours: number;       // Hours beyond regular threshold
  billableHours: number;
  nonBillableHours: number;
  periodStart: string;         // Formatted date string
  periodEnd: string;           // Formatted date string
  entries: TimesheetSyncEntry[]; // Raw entries for drill-down if needed
}

// ---------------------------------------------------------------------------
// Pre-Built Format Templates
// ---------------------------------------------------------------------------

export const PAYROLL_FORMATS: PayrollFormatConfig[] = [
  {
    id: 'adp',
    name: 'ADP Workforce Now',
    description: 'Standard ADP payroll import format with employee ID, hours, and earnings codes.',
    fileExtension: 'csv',
    delimiter: ',',
    dateFormat: 'MM/DD/YYYY',
    columns: [
      { key: 'employeeId', header: 'Employee ID', getValue: (r) => r.employeeId ?? r.employeeEmail },
      { key: 'lastName', header: 'Last Name', getValue: (r) => r.employeeName.split(' ').slice(-1)[0] ?? '' },
      { key: 'firstName', header: 'First Name', getValue: (r) => r.employeeName.split(' ')[0] ?? '' },
      { key: 'periodStart', header: 'Period Start', getValue: (r) => r.periodStart },
      { key: 'periodEnd', header: 'Period End', getValue: (r) => r.periodEnd },
      { key: 'regularHours', header: 'Regular Hours', getValue: (r) => r.regularHours.toFixed(2) },
      { key: 'overtimeHours', header: 'OT Hours', getValue: (r) => r.overtimeHours.toFixed(2) },
      { key: 'totalHours', header: 'Total Hours', getValue: (r) => r.totalHours.toFixed(2) },
      { key: 'earningsCode', header: 'Earnings Code', getValue: () => 'REG' },
    ],
  },
  {
    id: 'paychex',
    name: 'Paychex Flex',
    description: 'Paychex payroll import format with SSN/Employee ID and earnings codes.',
    fileExtension: 'csv',
    delimiter: ',',
    dateFormat: 'MM/DD/YYYY',
    columns: [
      { key: 'employeeId', header: 'Employee ID', getValue: (r) => r.employeeId ?? r.employeeEmail },
      { key: 'lastName', header: 'Last Name', getValue: (r) => r.employeeName.split(' ').slice(-1)[0] ?? '' },
      { key: 'firstName', header: 'First Name', getValue: (r) => r.employeeName.split(' ')[0] ?? '' },
      { key: 'payDate', header: 'Pay Date', getValue: (r) => r.periodEnd },
      { key: 'hours', header: 'Hours', getValue: (r) => r.regularHours.toFixed(2) },
      { key: 'earningsCode', header: 'Earnings Code', getValue: () => 'REG' },
      { key: 'otHours', header: 'OT Hours', getValue: (r) => r.overtimeHours.toFixed(2) },
      { key: 'otEarningsCode', header: 'OT Earnings Code', getValue: (r) => r.overtimeHours > 0 ? 'OT' : '' },
    ],
  },
  {
    id: 'gusto',
    name: 'Gusto',
    description: 'Gusto bulk hours import format — email-based employee matching.',
    fileExtension: 'csv',
    delimiter: ',',
    dateFormat: 'YYYY-MM-DD',
    columns: [
      { key: 'employeeEmail', header: 'employee_email', getValue: (r) => r.employeeEmail },
      { key: 'employeeName', header: 'employee_name', getValue: (r) => r.employeeName },
      { key: 'hours', header: 'hours', getValue: (r) => r.totalHours.toFixed(2) },
      { key: 'periodStart', header: 'pay_period_start', getValue: (r) => r.periodStart },
      { key: 'periodEnd', header: 'pay_period_end', getValue: (r) => r.periodEnd },
    ],
  },
  {
    id: 'custom',
    name: 'Custom Format',
    description: 'Configurable format — choose your own columns, headers, date format, and delimiter.',
    fileExtension: 'csv',
    delimiter: ',',
    dateFormat: 'YYYY-MM-DD',
    columns: [
      { key: 'employeeName', header: 'Employee Name', getValue: (r) => r.employeeName },
      { key: 'employeeEmail', header: 'Email', getValue: (r) => r.employeeEmail },
      { key: 'totalHours', header: 'Total Hours', getValue: (r) => r.totalHours.toFixed(2) },
      { key: 'billableHours', header: 'Billable Hours', getValue: (r) => r.billableHours.toFixed(2) },
      { key: 'nonBillableHours', header: 'Non-Billable Hours', getValue: (r) => r.nonBillableHours.toFixed(2) },
      { key: 'regularHours', header: 'Regular Hours', getValue: (r) => r.regularHours.toFixed(2) },
      { key: 'overtimeHours', header: 'Overtime Hours', getValue: (r) => r.overtimeHours.toFixed(2) },
      { key: 'periodStart', header: 'Period Start', getValue: (r) => r.periodStart },
      { key: 'periodEnd', header: 'Period End', getValue: (r) => r.periodEnd },
    ],
  },
];

// ---------------------------------------------------------------------------
// Aggregation Logic
// ---------------------------------------------------------------------------

const DEFAULT_REGULAR_HOURS_THRESHOLD = 80; // Semi-monthly: 80 hours = full-time

/**
 * Aggregate raw timesheet entries into per-employee totals for a period.
 */
export function aggregateEntriesByEmployee(
  entries: TimesheetSyncEntry[],
  dateFormat: string,
  regularHoursThreshold: number = DEFAULT_REGULAR_HOURS_THRESHOLD
): AggregatedEmployeeHours[] {
  // Group entries by employee
  const byEmployee = new Map<string, TimesheetSyncEntry[]>();
  for (const entry of entries) {
    const existing = byEmployee.get(entry.userId) ?? [];
    existing.push(entry);
    byEmployee.set(entry.userId, existing);
  }

  const aggregated: AggregatedEmployeeHours[] = [];

  for (const [userId, empEntries] of byEmployee) {
    const totalHours = empEntries.reduce((sum, e) => sum + e.hours, 0);
    const billableHours = empEntries.filter((e) => e.isBillable).reduce((sum, e) => sum + e.hours, 0);
    const nonBillableHours = totalHours - billableHours;
    const regularHours = Math.min(totalHours, regularHoursThreshold);
    const overtimeHours = Math.max(0, totalHours - regularHoursThreshold);

    // Find period boundaries from entries
    const dates = empEntries.map((e) => dayjs(e.entryDate));
    const minDate = dates.reduce((min, d) => d.isBefore(min) ? d : min, dates[0]);
    const maxDate = dates.reduce((max, d) => d.isAfter(max) ? d : max, dates[0]);

    aggregated.push({
      employeeName: empEntries[0].employeeName,
      employeeEmail: empEntries[0].employeeEmail,
      totalHours: Math.round(totalHours * 100) / 100,
      regularHours: Math.round(regularHours * 100) / 100,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
      billableHours: Math.round(billableHours * 100) / 100,
      nonBillableHours: Math.round(nonBillableHours * 100) / 100,
      periodStart: minDate.format(dateFormat),
      periodEnd: maxDate.format(dateFormat),
      entries: empEntries,
    });
  }

  // Sort by employee name
  aggregated.sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  return aggregated;
}

// ---------------------------------------------------------------------------
// CSV Generation
// ---------------------------------------------------------------------------

function escapeCSV(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Generate a CSV string from aggregated employee data using a format config.
 */
export function generatePayrollCSV(
  data: AggregatedEmployeeHours[],
  format: PayrollFormatConfig
): string {
  const { columns, delimiter } = format;

  // Header row
  const header = columns.map((c) => escapeCSV(c.header, delimiter)).join(delimiter);

  // Data rows
  const rows = data.map((row) =>
    columns.map((c) => escapeCSV(c.getValue(row), delimiter)).join(delimiter)
  );

  return [header, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Connector Implementation
// ---------------------------------------------------------------------------

export const payrollExportConnector: IntegrationConnector = {
  metadata,

  async generateExportFile(entries: TimesheetSyncEntry[], format: string) {
    const formatConfig = PAYROLL_FORMATS.find((f) => f.id === format);
    if (!formatConfig) {
      throw new Error(`Unknown payroll format: ${format}. Available: ${PAYROLL_FORMATS.map((f) => f.id).join(', ')}`);
    }

    const aggregated = aggregateEntriesByEmployee(entries, formatConfig.dateFormat);
    const csvContent = generatePayrollCSV(aggregated, formatConfig);

    const timestamp = dayjs().format('YYYY-MM-DD');
    const filename = `payroll-export-${format}-${timestamp}.${formatConfig.fileExtension}`;

    return {
      content: csvContent,
      filename,
      mimeType: 'text/csv;charset=utf-8;',
    };
  },
};
