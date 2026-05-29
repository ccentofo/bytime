'use server';

import { requireAdmin } from '@/lib/session';
import { getApprovedEntriesForSync } from '@/lib/integrations/sync-engine';
import {
  aggregateEntriesByEmployee,
  generatePayrollCSV,
  PAYROLL_FORMATS,
  type PayrollFormat,
  type AggregatedEmployeeHours,
} from '@/lib/integrations/connectors/payroll-export';
import dayjs from 'dayjs';

/**
 * Get available payroll export formats.
 */
export async function getPayrollFormats() {
  await requireAdmin();
  return PAYROLL_FORMATS.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
  }));
}

/**
 * Generate a payroll export preview (aggregated data without CSV formatting).
 * Used to show a preview table before downloading.
 */
export async function getPayrollExportPreview(data: {
  periodStart: Date;
  periodEnd: Date;
}): Promise<{
  employees: Array<{
    employeeName: string;
    employeeEmail: string;
    totalHours: number;
    regularHours: number;
    overtimeHours: number;
    billableHours: number;
    nonBillableHours: number;
    periodStart: string;
    periodEnd: string;
  }>;
  totalEntries: number;
}> {
  await requireAdmin();

  const entries = await getApprovedEntriesForSync(data.periodStart, data.periodEnd);

  const aggregated = aggregateEntriesByEmployee(entries, 'YYYY-MM-DD');

  return {
    employees: aggregated.map((a) => ({
      employeeName: a.employeeName,
      employeeEmail: a.employeeEmail,
      totalHours: a.totalHours,
      regularHours: a.regularHours,
      overtimeHours: a.overtimeHours,
      billableHours: a.billableHours,
      nonBillableHours: a.nonBillableHours,
      periodStart: a.periodStart,
      periodEnd: a.periodEnd,
    })),
    totalEntries: entries.length,
  };
}

/**
 * Generate a payroll export CSV string.
 * Returns the CSV content as a string (client handles download).
 */
export async function generatePayrollExportCSV(data: {
  periodStart: Date;
  periodEnd: Date;
  format: PayrollFormat;
}): Promise<{
  csvContent: string;
  filename: string;
  employeeCount: number;
  totalHours: number;
}> {
  await requireAdmin();

  const formatConfig = PAYROLL_FORMATS.find((f) => f.id === data.format);
  if (!formatConfig) {
    throw new Error(`Unknown payroll format: ${data.format}`);
  }

  const entries = await getApprovedEntriesForSync(data.periodStart, data.periodEnd);
  const aggregated = aggregateEntriesByEmployee(entries, formatConfig.dateFormat);
  const csvContent = generatePayrollCSV(aggregated, formatConfig);

  const timestamp = dayjs().format('YYYY-MM-DD');
  const filename = `payroll-export-${data.format}-${timestamp}.csv`;

  return {
    csvContent,
    filename,
    employeeCount: aggregated.length,
    totalHours: aggregated.reduce((sum, a) => sum + a.totalHours, 0),
  };
}
