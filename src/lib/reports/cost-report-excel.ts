import ExcelJS from 'exceljs';
import type { EmployeeSummaryEntry } from '@/server/actions/reports';
import type { CostReportEntry } from '@/server/internal/reports';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';

/**
 * Generate an Excel workbook with detailed cost report data.
 * Returns a Buffer that can be streamed to the client.
 */
export async function generateCostReportExcel(
  data: CostReportEntry[],
  reportTitle: string,
  dateRange: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CadenzPoint';
  workbook.created = new Date();

  // --- Sheet 1: Detailed Entries ---
  const detailSheet = workbook.addWorksheet('Detailed Cost Report');

  // Title row
  detailSheet.mergeCells('A1:K1');
  const titleCell = detailSheet.getCell('A1');
  titleCell.value = `${reportTitle} — ${dateRange}`;
  titleCell.font = { bold: true, size: 14 };

  // Subtitle
  detailSheet.mergeCells('A2:K2');
  detailSheet.getCell('A2').value = `Generated: ${new Date().toLocaleDateString('en-US', { dateStyle: 'full' })}`;
  detailSheet.getCell('A2').font = { italic: true, size: 10, color: { argb: '666666' } };

  // Headers
  const headers = [
    'Employee', 'Contract', 'Contract #', 'CLIN', 'SLIN',
    'LCAT Code', 'LCAT Title', 'Rate ($/hr)', 'Date', 'Hours', 'Cost ($)',
  ];

  const headerRow = detailSheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'E8E8E8' },
  };

  // Data rows
  for (const entry of data) {
    detailSheet.addRow([
      entry.employeeName,
      entry.contractName,
      entry.contractNumber,
      entry.clinNumber,
      entry.slinNumber ?? '',
      entry.lcatCode,
      entry.lcatTitle,
      entry.hourlyRate,
      entry.entryDate,
      entry.totalHours,
      entry.totalCost,
    ]);
  }

  // Totals row
  const totalHours = data.reduce((sum, e) => sum + e.totalHours, 0);
  const totalCost = data.reduce((sum, e) => sum + e.totalCost, 0);
  const totalsRow = detailSheet.addRow([
    'TOTALS', '', '', '', '', '', '', '', '',
    Math.round(totalHours * 100) / 100,
    Math.round(totalCost * 100) / 100,
  ]);
  totalsRow.font = { bold: true };
  // certified-outputs C3 (CO-D17 / ruling Q6): the unpriced count travels with every cost total, plus the CO-D7 note.
  const unpriced = Math.round(data.reduce((sum, e) => sum + e.unpricedHours, 0) * 100) / 100;
  detailSheet.addRow(['UNPRICED HOURS (no applicable labor category — no cost)', '', '', '', '', '', '', '', '', unpriced, '']).font = { italic: true };
  detailSheet.addRow([CURRENT_RATES_NOTE]).font = { italic: true, color: { argb: '666666' } };

  // Column widths
  detailSheet.columns = [
    { width: 20 }, { width: 25 }, { width: 18 }, { width: 10 }, { width: 10 },
    { width: 12 }, { width: 25 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 14 },
  ];

  // Format currency columns
  detailSheet.getColumn(8).numFmt = '$#,##0.00';
  detailSheet.getColumn(11).numFmt = '$#,##0.00';
  detailSheet.getColumn(10).numFmt = '#,##0.00';

  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Generate an Excel workbook with employee summary data.
 *
 * R2-5: `includeCost` controls whether the Total Cost column exists at all — supervisors never
 * see dollar figures, so for them this must be an hours-only sheet, not a cost column of zeros.
 */
export async function generateEmployeeSummaryExcel(
  data: EmployeeSummaryEntry[],
  dateRange: string,
  includeCost: boolean
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CadenzPoint';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Employee Summary');

  // Title
  sheet.mergeCells(includeCost ? 'A1:F1' : 'A1:E1');
  sheet.getCell('A1').value = `Employee Summary Report — ${dateRange}`;
  sheet.getCell('A1').font = { bold: true, size: 14 };

  // Headers
  const headers = includeCost
    ? ['Employee', 'Contract', 'Contract #', 'CLIN', 'Total Hours', 'Total Cost ($)']
    : ['Employee', 'Contract', 'Contract #', 'CLIN', 'Total Hours'];
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'E8E8E8' },
  };

  // Data
  for (const entry of data) {
    const row: Array<string | number> = [
      entry.employeeName,
      entry.contractName,
      entry.contractNumber,
      entry.clinNumber,
      entry.totalHours,
    ];
    if (includeCost) row.push(entry.totalCost ?? 0);
    sheet.addRow(row);
  }

  // Totals
  const totalHours = data.reduce((sum, e) => sum + e.totalHours, 0);
  const totalsRowValues: Array<string | number> = ['TOTALS', '', '', '', Math.round(totalHours * 100) / 100];
  if (includeCost) {
    const totalCost = data.reduce((sum, e) => sum + (e.totalCost ?? 0), 0);
    totalsRowValues.push(Math.round(totalCost * 100) / 100);
  }
  const totalsRow = sheet.addRow(totalsRowValues);
  totalsRow.font = { bold: true };
  if (includeCost) {
    // certified-outputs C3 (CO-D17 / ruling Q6): unpriced hours beside the cost total, plus the CO-D7 note.
    const unpriced = Math.round(data.reduce((sum, e) => sum + (e.unpricedHours ?? 0), 0) * 100) / 100;
    sheet.addRow(['UNPRICED HOURS (no applicable labor category — no cost)', '', '', '', unpriced, '']).font = { italic: true };
    sheet.addRow([CURRENT_RATES_NOTE]).font = { italic: true, color: { argb: '666666' } };
  }

  // Widths
  sheet.columns = includeCost
    ? [{ width: 22 }, { width: 28 }, { width: 18 }, { width: 12 }, { width: 14 }, { width: 16 }]
    : [{ width: 22 }, { width: 28 }, { width: 18 }, { width: 12 }, { width: 14 }];

  sheet.getColumn(5).numFmt = '#,##0.00';
  if (includeCost) sheet.getColumn(6).numFmt = '$#,##0.00';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
