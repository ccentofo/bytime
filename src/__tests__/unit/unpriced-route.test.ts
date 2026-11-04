import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { NextRequest } from 'next/server';

/**
 * feature-plan-ux-kit-contracts.md §4.4.8 / U-3, unit companion to integration/unpriced-report.test.ts: the
 * unpriced-xlsx route with the guarded action mocked — 400 on an invalid filter, 422 when there's nothing (never 404),
 * three sheets with every group in order, the rates note on each sheet, a truncation row past 50,000 entries.
 */

const h = vi.hoisted(() => ({ data: null as unknown, calls: [] as unknown[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/rate-limit', () => ({ checkReportRateLimit: () => null }));
vi.mock('@/server/actions/labor-categories', () => ({ getUnpricedExportData: vi.fn(async (f: unknown) => { h.calls.push(f); return h.data; }) }));

import { GET } from '@/app/api/reports/unpriced-xlsx/route';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';

const group = (employeeName: string, hours: number) => ({
  key: employeeName, reason: 'no-category', level: null, userId: 'u', employeeName, contractId: 'k', contractName: 'Army', clinId: 'c', clinNumber: '0001',
  slinId: null, slinNumber: null, chargeCodeId: 'cc', chargeCode: 'ARMY-0001', hours, first: '2026-03-02', last: '2026-03-03', entries: 2, overlaps: [], fix: { kind: 'set-code-category', chargeCodeId: 'cc' },
});
const req = (q = '') => new NextRequest(`http://localhost/api/reports/unpriced-xlsx${q}`);
const NO_SCOPE = { contract: null, clinNumber: null, slinNumber: null };
beforeEach(() => { h.calls = []; h.data = { groups: [], overlaps: [], entries: [], entriesTruncated: false, scope: NO_SCOPE }; });

describe('unpriced-xlsx (U-3 companion)', () => {
  it('an invalid filter → 400 before the action runs', async () => {
    for (const q of ['?contractId=nope', '?start=2026-02-30', '?reason=other']) expect((await GET(req(q))).status, q).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('nothing to fix and no overlaps → 422 with a message, never 404', async () => {
    const res = await GET(req('?start=2026-01-01&end=2026-01-31'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'There are no unpriced hours or overlapping assignments to download.' });
    expect(h.calls).toEqual([{ startDate: '2026-01-01', endDate: '2026-01-31' }]);
  });

  it('three sheets, every group in the given order, the rates note on each sheet, and a truncation row', async () => {
    h.data = {
      groups: [group('Jane Smith', 412.5), group('John Doe', 380)], overlaps: [],
      entries: [{ entryDate: '2026-03-02', employeeName: 'Jane Smith', chargeCode: 'ARMY-0001', clinNumber: '0001', slinNumber: null, hours: 8, reason: 'no-category', fix: 'x' }],
      entriesTruncated: true, scope: NO_SCOPE,
    };
    const res = await GET(req('?startDate=2026-01-01'));                 // the legacy name is accepted
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['To fix', 'Overlaps', 'Every entry']);
    for (const w of wb.worksheets) expect(w.getRow(3).getCell(1).value, w.name).toBe(CURRENT_RATES_NOTE);
    const fix = wb.getWorksheet('To fix')!;
    expect([fix.getRow(5).getCell(2).value, fix.getRow(6).getCell(2).value]).toEqual(['Jane Smith', 'John Doe']);
    const every = wb.getWorksheet('Every entry')!;
    expect(String(every.getRow(every.rowCount).getCell(1).value)).toMatch(/^Only the first 50,000 entries are listed\./);
  });
});

const pair = {
  userId: 'u9', employeeName: 'Dee Future', level: 'clin', contractId: 'k', clinId: 'c', slinId: null, clinNumber: '0001', slinNumber: null,
  a: { assignmentId: 'a1', lcatCode: 'SE-II', title: 'Eng II', effectiveDate: '2027-01-01', endDate: null },
  b: { assignmentId: 'b1', lcatCode: 'SE-III', title: 'Eng III', effectiveDate: '2027-02-01', endDate: '2027-06-30' },
};
const sheetsOf = async (res: Response) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never); return wb; };

describe('unpriced-xlsx (UX-4B1-AUDIT L5, L8)', () => {
  it('L5: no groups but an overlap → 200, and the Overlaps sheet lists the pair', async () => {
    h.data = { groups: [], overlaps: [pair], entries: [], entriesTruncated: false, scope: NO_SCOPE };
    const res = await GET(req());
    expect(res.status).toBe(200);
    const overlaps = (await sheetsOf(res)).getWorksheet('Overlaps')!;
    expect([overlaps.getRow(5).getCell(1).value, overlaps.getRow(5).getCell(4).value]).toEqual(['Dee Future', 'SE-II Eng II']);
  });

  it('L8: a legacy key beside its preferred one is no 400; start/end win', async () => {
    const res = await GET(req('?start=2026-01-01&startDate=2025-06-01&end=2026-01-31&endDate=2025-06-30'));
    expect(res.status).toBe(422);                                  // nothing to fix — but not refused
    expect(h.calls).toEqual([{ startDate: '2026-01-01', endDate: '2026-01-31' }]);
    expect((await GET(req('?start=2026-01-01&startDate=nope'))).status).toBe(400);   // an invalid value still is
  });

  it('L8: the scope line names the contract, CLIN and SLIN, and one-sided ranges', async () => {
    type Names = { contract: string | null; clinNumber: string | null; slinNumber: string | null };
    const scoped: Names = { contract: 'Army (W1)', clinNumber: '0001', slinNumber: '0001AA' };
    const cases: Array<[string, Names, string]> = [
      ['?start=2026-10-01', scoped, 'From Oct 1, 2026 · Army (W1) · CLIN 0001 · SLIN 0001AA'],
      ['?end=2026-10-31&reason=conflict', { ...scoped, slinNumber: null }, 'Through Oct 31, 2026 · Army (W1) · CLIN 0001 · overlapping categories only'],
      ['?start=2026-10-01&end=2026-10-31', NO_SCOPE, 'Oct 1 – 31, 2026'],
      ['', { contract: 'Army (W1)', clinNumber: null, slinNumber: null }, 'All time · Army (W1)'],
    ];
    for (const [q, scope, line] of cases) {
      h.data = { groups: [], overlaps: [pair], entries: [], entriesTruncated: false, scope };
      const wb = await sheetsOf(await GET(req(q)));
      expect(wb.getWorksheet('To fix')!.getRow(2).getCell(1).value, q).toBe(line);
    }
  });
});

