import ExcelJS from 'exceljs';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';
import type { OverlapRow, UnpricedGroup } from '@/server/internal/cost-basis';
import type { UnpricedHoursReportRow } from '@/server/actions/labor-categories';

/**
 * The Unpriced hours workbook (feature-plan-ux-kit-contracts.md §4.4.8): "To fix" (every group, in the report's order),
 * "Overlaps" (every pair in scope) and "Every entry" (per-entry detail for auditors, with a row saying so if it was
 * cut off). Each sheet carries the CO-D7 rates note.
 */
const REASON = { 'no-category': 'No category', conflict: 'Overlapping categories' } as const;
const where = (g: Pick<UnpricedGroup, 'chargeCode' | 'contractName' | 'clinNumber' | 'slinNumber'>) =>
  g.chargeCode ?? `${g.contractName} CLIN ${g.clinNumber}${g.slinNumber ? ` SLIN ${g.slinNumber}` : ''}`;

function header(sheet: ExcelJS.Worksheet, title: string, scope: string, columns: string[]) {
  sheet.addRow([title]).font = { bold: true, size: 14 };
  sheet.addRow([scope]).font = { italic: true, size: 10, color: { argb: '666666' } };
  sheet.addRow([CURRENT_RATES_NOTE]).font = { italic: true, size: 10, color: { argb: '666666' } };
  const row = sheet.addRow(columns);
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E8E8E8' } };
}

export async function generateUnpricedExcel(data: {
  groups: UnpricedGroup[];
  overlaps: OverlapRow[];
  entries: UnpricedHoursReportRow[];
  entriesTruncated: boolean;
  entryLimit: number;
  scope: string;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CadenzPoint';
  workbook.created = new Date();

  const fix = workbook.addWorksheet('To fix');
  header(fix, 'Unpriced hours — things to fix', data.scope, ['What\'s wrong', 'Employee', 'Where', 'Hours', 'First date', 'Last date', 'Entries']);
  for (const g of data.groups) fix.addRow([REASON[g.reason], g.employeeName, where(g), g.hours, g.first, g.last, g.entries]);

  const pairs = workbook.addWorksheet('Overlaps');
  header(pairs, 'Overlapping labor-category assignments', data.scope, ['Employee', 'Level', 'CLIN / SLIN', 'Category A', 'A from', 'A to', 'Category B', 'B from', 'B to']);
  for (const p of data.overlaps) {
    pairs.addRow([
      p.employeeName, p.level === 'slin' ? 'SLIN' : 'CLIN', p.slinNumber ? `CLIN ${p.clinNumber} SLIN ${p.slinNumber}` : `CLIN ${p.clinNumber}`,
      `${p.a.lcatCode} ${p.a.title}`, p.a.effectiveDate, p.a.endDate ?? '', `${p.b.lcatCode} ${p.b.title}`, p.b.effectiveDate, p.b.endDate ?? '',
    ]);
  }

  const every = workbook.addWorksheet('Every entry');
  header(every, 'Every unpriced entry', data.scope, ['Date', 'Employee', 'Charge code', 'CLIN', 'SLIN', 'Hours', 'Reason', 'How to fix']);
  for (const e of data.entries) {
    every.addRow([e.entryDate, e.employeeName, e.chargeCode ?? '', e.clinNumber, e.slinNumber ?? '', e.hours, REASON[e.reason], e.fix]);
  }
  if (data.entriesTruncated) {
    every.addRow([`Only the first ${data.entryLimit.toLocaleString('en-US')} entries are listed. Narrow the filters to see the rest.`]).font = { bold: true };
  }

  for (const sheet of [fix, pairs, every]) sheet.columns.forEach((c) => { c.width = 22; });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
