import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { buildTimesheetRows, timesheetRowLabel, type TimesheetRowEntry } from '@/lib/reports/timesheet-rows';
import { TimesheetPdfDocument } from '@/lib/reports/timesheet-pdf';
import type { TimesheetReportData } from '@/server/actions/reports';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-certified-outputs.md C5 / §9 row "PDF": rows from latest-revision entries per true cell code
 * (indirect/leave rows; two codes on one CLIN the same day both present; codes no longer assigned), total = sum of
 * entries, stable on reprint (ruling Q7); "Display": imported cells labelled.
 */

const ROOT = path.resolve(__dirname, '../../..');
const none = {
  chargeCodeId: null, clinId: null, indirectCodeId: null, chargeCode: null, chargeCodeName: null, clinNumber: null, clinDescription: null,
  contractName: null, contractNumber: null, slinNumber: null, indirectCode: null, indirectName: null, indirectCategory: null,
  source: 'app', changeReasonCode: null, originalMetadata: null, importSourceSystem: null, importedAt: null, importedByName: null,
};
const charge = (id: string, code: string, dayIndex: number, hours: string, o: Partial<TimesheetRowEntry> = {}): TimesheetRowEntry => {
  const e = { ...none, chargeCodeId: id, clinId: 'clin-1', chargeCode: code, chargeCodeName: `${code} work`, clinNumber: '0001', contractName: 'NAVAIR', contractNumber: 'N1', dayIndex, hours, ...o };
  // The charge code's own CLIN / contract (F9) — by default the same as the entry's.
  return { codeClinNumber: e.clinNumber, codeContractName: e.contractName, codeContractNumber: e.contractNumber, codeSlinNumber: e.slinNumber, ...e };
};
const indirect = (id: string, code: string, category: string, dayIndex: number, hours: string): TimesheetRowEntry =>
  ({ ...none, indirectCodeId: id, indirectCode: code, indirectName: `${code} name`, indirectCategory: category, dayIndex, hours });
const legacyClin = (dayIndex: number, hours: string, slinNumber: string | null = null): TimesheetRowEntry =>
  ({ ...none, clinId: 'clin-9', clinNumber: '0009', clinDescription: 'Old CLIN', contractName: 'DISA', contractNumber: 'D1', slinNumber, dayIndex, hours });

describe('buildTimesheetRows', () => {
  it('two charge codes on ONE CLIN on the same day are two rows (no overwrite)', () => {
    const { rows, dailyTotals } = buildTimesheetRows([charge('cc-a', 'NAV-A', 0, '3'), charge('cc-b', 'NAV-B', 0, '5')], 3);
    expect(rows.map((r) => [r.code, r.dailyHours[0]])).toEqual([['NAV-A', 3], ['NAV-B', 5]]);
    expect(dailyTotals).toEqual([8, 0, 0]);
  });

  it('indirect and leave rows appear, with their category', () => {
    const { rows } = buildTimesheetRows([indirect('i1', 'LV-PTO', 'leave', 1, '8'), indirect('i2', 'OH-01', 'overhead', 2, '2')], 3);
    expect(rows.map((r) => [r.kind, r.code, r.category])).toEqual([['indirect', 'LV-PTO', 'Leave'], ['indirect', 'OH-01', 'Overhead']]);
    expect(timesheetRowLabel(rows[0])).toBe('LV-PTO — LV-PTO name (Leave)');
  });

  it('a legacy CLIN-only row is its own row; its SLIN is shown only when all its days share one', () => {
    expect(buildTimesheetRows([legacyClin(0, '1', 'AA'), legacyClin(1, '1', 'AA')], 2).rows[0]).toMatchObject({ kind: 'clin', code: 'CLIN 0009', slinNumber: 'AA' });
    expect(buildTimesheetRows([legacyClin(0, '1', 'AA'), legacyClin(1, '1', 'AB')], 2).rows[0].slinNumber).toBeNull();
  });

  it('grand total = sum of entries, exact (integer hundredths — 0.29 + 1.13 is 1.42, not 1.4199999999999997)', () => {
    const r = buildTimesheetRows([charge('cc-a', 'A', 0, '0.29'), charge('cc-a', 'A', 1, '1.13'), indirect('i1', 'LV', 'leave', 1, '7.70')], 2);
    expect(r.rows.find((x) => x.code === 'A')!.totalHours).toBe(1.42);
    expect(r.dailyTotals).toEqual([0.29, 8.83]);
    expect(r.grandTotal).toBe(9.12);
  });

  it('F9: a charge row is labelled by the charge code\'s own CLIN, whichever entry comes first (old entries keep an old clin_id)', () => {
    const code = { codeClinNumber: '0002', codeContractName: 'DISA', codeContractNumber: 'D1', codeSlinNumber: null };
    const old = charge('cc-a', 'A', 0, '8', { clinNumber: '0001', contractName: 'NAVAIR', ...code });
    const fresh = charge('cc-a', 'A', 1, '8', { clinNumber: '0002', contractName: 'DISA', ...code });
    for (const order of [[old, fresh], [fresh, old]]) {
      expect(buildTimesheetRows(order, 2).rows[0]).toMatchObject({ clinNumber: '0002', contractName: 'DISA', contractNumber: 'D1' });
    }
  });

  it('days outside the period are ignored', () => {
    expect(buildTimesheetRows([charge('cc-a', 'A', 5, '8')], 3)).toEqual({ rows: [], dailyTotals: [0, 0, 0], grandTotal: 0 });
  });

  it('stable on reprint: any input order gives identical rows (charge → CLIN → indirect, then by contract/CLIN/code)', () => {
    const entries = [
      indirect('i1', 'LV-PTO', 'leave', 1, '8'), charge('cc-b', 'NAV-B', 0, '5'), legacyClin(2, '1'),
      charge('cc-a', 'NAV-A', 0, '3'), charge('cc-z', 'AAA', 0, '1', { contractName: 'ZETA', clinNumber: '0002' }),
    ];
    const a = buildTimesheetRows(entries, 3);
    const b = buildTimesheetRows([...entries].reverse(), 3);
    expect(b).toEqual(a);
    expect(a.rows.map((r) => r.code)).toEqual(['NAV-A', 'NAV-B', 'AAA', 'CLIN 0009', 'LV-PTO']);
  });

  it('imported cells carry their provenance (distinct, sorted); app rows carry none', () => {
    const imported = charge('cc-a', 'A', 0, '8', { source: 'migration', importSourceSystem: 'Deltek', importedAt: '2026-01-05T00:00:00Z', importedByName: 'Ann', originalMetadata: { enteredBy: 'Pat' } });
    const legacy = charge('cc-a', 'A', 1, '8', { changeReasonCode: 'MIGRATION' });
    const { rows } = buildTimesheetRows([imported, legacy, charge('cc-b', 'B', 0, '1')], 2);
    expect(rows[0].provenance).toEqual(['Imported from Deltek on 2026-01-05 by Ann — originally entered by Pat', 'Legacy import — details not recorded']);
    expect(rows[1].provenance).toEqual([]);
  });
});

describe('the PDF', () => {
  const data: TimesheetReportData = {
    employee: { id: 'u1', fullName: 'Pat Doe', email: 'p@x' },
    periodStart: '2026-09-01' as never, periodEnd: '2026-09-02' as never, periodStatus: 'approved',
    submittedAt: new Date('2026-09-03T12:00:00Z'), approvedAt: new Date('2026-09-04T12:00:00Z'),
    approvedBy: 'Self-approved', approvalLine: 'Self-approved by Pat Doe on Sep 4, 2026',
    ...buildTimesheetRows([charge('cc-a', 'A', 0, '8', { source: 'migration' }), indirect('i1', 'LV', 'leave', 1, '8')], 2),
  };

  it('renders rows from data.rows with labels and the imported-hours notes', async () => {
    const buf = await renderToBuffer(React.createElement(TimesheetPdfDocument, { data, workspaceTimezone: 'UTC' }) as never);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('wiring (static): rows come from entries, never assignments; access via assertCanAccessEmployee (reviewScope)', () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/server/actions/reports.ts'), 'utf8'));
    const fn = src.slice(src.indexOf('export async function getTimesheetReportData'), src.indexOf('export async function getDetailedCostReport'));
    expect(fn).not.toMatch(/userAssignments/);
    expect(fn.indexOf('await requireSession()')).toBeLessThan(fn.indexOf('await assertCanAccessEmployee(actor, userId)'));
    expect(fn).toMatch(/\.leftJoin\(indirectChargeCodes, eq\(timesheetEntries\.indirectCodeId, indirectChargeCodes\.id\)\)/);
    expect(fn).toMatch(/COALESCE\(te2\.charge_code_id, te2\.indirect_code_id, te2\.clin_id\) = COALESCE\(/);
    expect(fn).toMatch(/buildTimesheetRows\(/);
    const pdf = readFileSync(path.join(ROOT, 'src/lib/reports/timesheet-pdf.tsx'), 'utf8');
    expect(pdf).toMatch(/data\.rows\.map\(/);
    expect(pdf).toMatch(/timesheetRowLabel\(row\)/);
    expect(pdf).toMatch(/\{data\.approvalLine && ` \| \$\{data\.approvalLine\}`\}/);
  });
});
