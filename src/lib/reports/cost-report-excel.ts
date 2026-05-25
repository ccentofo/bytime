import ExcelJS from 'exceljs';
import type { CostReportEntry, EmployeeSummaryEntry } from '@/server/actions/reports';

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
  workbook.creator = 'ByTime';
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
 */
export async function generateEmployeeSummaryExcel(
  data: EmployeeSummaryEntry[],
  dateRange: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ByTime';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Employee Summary');

  // Title
  sheet.mergeCells('A1:F1');
  sheet.getCell('A1').value = `Employee Summary Report — ${dateRange}`;
  sheet.getCell('A1').font = { bold: true, size: 14 };

  // Headers
  const headers = ['Employee', 'Contract', 'Contract #', 'CLIN', 'Total Hours', 'Total Cost ($)'];
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'E8E8E8' },
  };

  // Data
  for (const entry of data) {
    sheet.addRow([
      entry.employeeName,
      entry.contractName,
      entry.contractNumber,
      entry.clinNumber,
      entry.totalHours,
      entry.totalCost,
    ]);
  }

  // Totals
  const totalHours = data.reduce((sum, e) => sum + e.totalHours, 0);
  const totalCost = data.reduce((sum, e) => sum + e.totalCost, 0);
  const totalsRow = sheet.addRow([
    'TOTALS', '', '', '',
    Math.round(totalHours * 100) / 100,
    Math.round(totalCost * 100) / 100,
  ]);
  totalsRow.font = { bold: true };

  // Widths
  sheet.columns = [
    { width: 22 }, { width: 28 }, { width: 18 }, { width: 12 }, { width: 14 }, { width: 16 },
  ];

  sheet.getColumn(5).numFmt = '#,##0.00';
  sheet.getColumn(6).numFmt = '$#,##0.00';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
