import ExcelJS from 'exceljs';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';
import { periodLabel } from '@/lib/timesheet/labels';
import type { PeriodCostReport } from '@/server/actions/reports';

/**
 * The "Cost by pay period" workbook (feature-plan-ux-kit-contracts.md §4.5, R3): one sheet — Period, Contract, Hours,
 * Priced cost, Unpriced hours — one row per period × contract, a totals row after each period (also for a period with
 * no hours), and the CO-D7 rates note. Per-period figures aren't expected to equal the all-time Contracts figures.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function generatePeriodCostExcel(report: PeriodCostReport, n: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CadenzPoint';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Cost by pay period');

  const first = report.periods[0];
  const last = report.periods[report.periods.length - 1];
  sheet.addRow(['Cost by pay period']).font = { bold: true, size: 14 };
  sheet.addRow([`Last ${n} pay periods · ${periodLabel(first.start, last.end)}`]).font = { italic: true, size: 10, color: { argb: '666666' } };
  sheet.addRow([CURRENT_RATES_NOTE]).font = { italic: true, size: 10, color: { argb: '666666' } };
  const head = sheet.addRow(['Period', 'Contract', 'Hours', 'Priced cost ($)', 'Unpriced hours']);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E8E8E8' } };

  for (const p of report.periods) {
    const label = periodLabel(p.start, p.end);
    const rows = report.rows.filter((r) => r.periodStart === p.start);
    for (const r of rows) sheet.addRow([label, `${r.contractName} (${r.contractNumber})`, r.hours, r.pricedCost, r.unpricedHours]);
    const total = sheet.addRow([
      label, 'Total',
      round2(rows.reduce((s, r) => s + r.hours, 0)),
      round2(rows.reduce((s, r) => s + r.pricedCost, 0)),
      round2(rows.reduce((s, r) => s + r.unpricedHours, 0)),
    ]);
    total.font = { bold: true };
  }

  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 40;
  for (const c of [3, 4, 5]) { sheet.getColumn(c).width = 16; sheet.getColumn(c).numFmt = '#,##0.00'; }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
