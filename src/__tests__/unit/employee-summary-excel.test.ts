import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { generateEmployeeSummaryExcel } from '@/lib/reports/cost-report-excel';
import type { EmployeeSummaryEntry } from '@/server/actions/reports';

// ---------------------------------------------------------------------------
// R2-5: the employee summary Excel sheet must not have a cost column at all for
// supervisors (includeCost=false) — not a column full of zeros.
// ---------------------------------------------------------------------------

const ADMIN_DATA: EmployeeSummaryEntry[] = [
  { employeeId: 'u-alice', employeeName: 'Alice', contractName: 'Contract A', contractNumber: 'C-1', clinNumber: '0001', totalHours: 10, totalCost: 500, flsaExempt: false },
];

const SUPERVISOR_DATA: EmployeeSummaryEntry[] = [
  { employeeId: 'u-alice', employeeName: 'Alice', contractName: 'Contract A', contractNumber: 'C-1', clinNumber: '0001', totalHours: 10, flsaExempt: false },
];

describe('generateEmployeeSummaryExcel includeCost (R2-5)', () => {
  it('includes a Total Cost column and value for admins', async () => {
    const buffer = await generateEmployeeSummaryExcel(ADMIN_DATA, '2026-01-01 to 2026-01-31', true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];

    const headerValues = (sheet.getRow(2).values as any[]).filter((v) => v !== undefined).map(String);
    expect(headerValues).toContain('Total Cost ($)');

    const dataRowValues = sheet.getRow(3).values as any[];
    expect(dataRowValues).toContain(500);
  });

  it('omits the Total Cost column entirely for supervisors', async () => {
    const buffer = await generateEmployeeSummaryExcel(SUPERVISOR_DATA, '2026-01-01 to 2026-01-31', false);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];

    const headerValues = (sheet.getRow(2).values as any[]).filter((v) => v !== undefined).map(String);
    expect(headerValues).not.toContain('Total Cost ($)');
    expect(sheet.columnCount).toBe(5);
  });
});
