import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * feature-plan-excel-cost-report.md §11 T10 (CSV half), T11, T16: the cost report CSV through the real route and the
 * real generateCsv (report-routes.test.ts mocks the generator for its whole file, so these live here). Runnable
 * without Postgres: the server action is mocked to return rows.
 */

const h = vi.hoisted(() => ({ detailed: [] as unknown[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/rate-limit', () => ({ checkReportRateLimit: () => null }));
vi.mock('@/server/actions/reports', () => ({ getDetailedCostReport: vi.fn(async () => h.detailed) }));
vi.mock('@/lib/session', () => ({ getSessionUser: async () => ({ role: 'admin' }), AuthorizationError: class AuthorizationError extends Error {} }));

import { GET as csvGET } from '@/app/api/reports/cost-report-csv/route';
import { escapeCsvField } from '@/lib/csv/escape';
import { generateCsv } from '@/lib/reports/csv-generator';
import { CURRENT_CLASS_NOTE, CURRENT_RATES_NOTE } from '@/lib/cost-labels';
import type { CostReportEntry } from '@/server/internal/reports';

const row = (o: Partial<CostReportEntry> = {}): CostReportEntry => ({
  employeeName: 'Pat', employeeEmail: 'p@x', contractName: 'C', contractNumber: 'N', clinNumber: '0001', slinNumber: null,
  chargeCode: 'NAVAIR-0001-ONSITE', className: 'Government Services', lcatCode: 'SE2', lcatTitle: 'Eng', hourlyRate: 100,
  totalHours: 8, totalCost: 800, entryDate: '2026-09-01', costBasis: 'priced', unpricedReason: null, unpricedHours: 0, ...o,
});
const req = () => new NextRequest('http://localhost/api/reports/cost-report-csv?startDate=2026-09-01&endDate=2026-09-30');
const HEADERS_14 = 'Employee,Contract,Contract Number,CLIN,SLIN,Charge Code,Class,LCAT Code,LCAT Title,Rate ($/hr),Date,Hours,Cost ($),Cost Basis';

beforeEach(() => { h.detailed = [row()]; });

describe('cost report CSV (feature-plan-excel-cost-report.md §6.3)', () => {
  it('T11: 14 headers with Charge Code and Class after SLIN; a row with no charge code has blank fields 6 and 7; the escaped Class note is the last line', async () => {
    h.detailed = [row(), row({ chargeCode: null, className: null })];
    const res = await csvGET(req());
    expect(res.status).toBe(200);
    const lines = (await res.text()).split('\n');
    expect(lines[0]).toBe(HEADERS_14);
    expect(lines[1].split(',').slice(5, 7)).toEqual(['NAVAIR-0001-ONSITE', 'Government Services']);
    expect(lines[2].split(',').slice(5, 7)).toEqual(['', '']);
    const nonEmpty = lines.filter((l) => l !== '');
    expect(nonEmpty[nonEmpty.length - 1]).toBe(escapeCsvField(CURRENT_CLASS_NOTE));
    expect(nonEmpty[nonEmpty.length - 1]).toBe(`"${CURRENT_CLASS_NOTE}"`); // it has a comma, so it's quoted
  });

  it('T10 (CSV half): a formula-looking code is prefixed with an apostrophe; a Class with a comma and quotes is quoted', async () => {
    h.detailed = [row({ chargeCode: '=1+1', className: 'R&D, "Labs"' })];
    const lines = (await (await csvGET(req())).text()).split('\n');
    expect(lines[1]).toContain(`,'=1+1,"R&D, ""Labs""",SE2,`);
  });

  it('T16: the body starts with exactly one UTF-8 byte-order mark; the 422 "no hours" JSON has none', async () => {
    const b = Buffer.from(await (await csvGET(req())).arrayBuffer());
    expect([...b.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(b.subarray(3, 11).toString()).toBe('Employee');

    h.detailed = [row({ totalHours: 0, totalCost: 0 })];
    const empty = await csvGET(req());
    expect(empty.status).toBe(422);
    expect(Buffer.from(await empty.arrayBuffer())[0]).toBe(0x7b); // '{'
  });
});

// ── feature-plan-large-report-responses.md §11 T6, T7: the body streams, byte for byte as before ──────────────────────
// The test's OWN copy of the 14 columns in today's order: an independent oracle for the route's inline list.
const COLUMNS: { key: keyof CostReportEntry; header: string }[] = [
  { key: 'employeeName', header: 'Employee' }, { key: 'contractName', header: 'Contract' },
  { key: 'contractNumber', header: 'Contract Number' }, { key: 'clinNumber', header: 'CLIN' }, { key: 'slinNumber', header: 'SLIN' },
  { key: 'chargeCode', header: 'Charge Code' }, { key: 'className', header: 'Class' }, { key: 'lcatCode', header: 'LCAT Code' },
  { key: 'lcatTitle', header: 'LCAT Title' }, { key: 'hourlyRate', header: 'Rate ($/hr)' }, { key: 'entryDate', header: 'Date' },
  { key: 'totalHours', header: 'Hours' }, { key: 'totalCost', header: 'Cost ($)' }, { key: 'costBasis', header: 'Cost Basis' },
];
const footerFor = (unpriced: number) =>
  `\nUnpriced hours (no applicable labor category; no cost),${unpriced}\n${CURRENT_RATES_NOTE}\n${escapeCsvField(CURRENT_CLASS_NOTE)}\n`;
const synthetic = (i: number, pad = ''): CostReportEntry => row({
  employeeName: 'Emp ' + i,
  contractName: 'Contract ' + pad,
  slinNumber: i % 3 ? null : 'S' + i,
  chargeCode: i === 7 ? '=1+1' : i % 5 ? 'CC-' + i : null,
  className: i === 11 ? 'R&D, "Labs"' : i % 4 ? 'Class ' + (i % 4) : null,
  costBasis: i % 9 ? 'priced' : 'unpriced',
  unpricedHours: i % 9 ? 0 : 8,
});
async function chunkCount(res: Response): Promise<{ chunks: number; bytes: number }> {
  const reader = res.body!.getReader();
  let chunks = 0; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { chunks, bytes };
    chunks++; bytes += value.byteLength;
  }
}

describe('cost report CSV streams (feature-plan-large-report-responses.md §6.2)', () => {
  it('T6: 2,500 rows: the bytes equal BOM + generateCsv + footer; more than one chunk; headers unchanged', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => synthetic(i));
    h.detailed = rows;
    const unpriced = Math.round(rows.reduce((s, r) => s + r.unpricedHours, 0) * 100) / 100;
    expect(unpriced).toBeGreaterThan(0);
    const res = await csvGET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="cost-report-2026-09-01-to-2026-09-30.csv"');
    const expected = Buffer.from('\uFEFF' + generateCsv(rows, COLUMNS) + footerFor(unpriced));
    expect(Buffer.from(await res.arrayBuffer()).equals(expected)).toBe(true);

    const second = await chunkCount(await csvGET(req()));
    expect(second.chunks).toBeGreaterThan(1);
    expect(second.bytes).toBe(expected.byteLength);
  });

  it('T7: 31,000 padded rows: over 4.5 MB, at least 32 chunks, ending in the Class note, 31,004 non-empty lines', async () => {
    h.detailed = Array.from({ length: 31_000 }, (_, i) => synthetic(i, 'x'.repeat(80)));
    const { chunks, bytes } = await chunkCount(await csvGET(req()));
    expect(bytes).toBeGreaterThan(4_500_000);
    expect(chunks).toBeGreaterThanOrEqual(32);

    const lines = (await (await csvGET(req())).text()).split('\n').filter((l) => l !== '');
    expect(lines[lines.length - 1]).toBe(escapeCsvField(CURRENT_CLASS_NOTE));
    expect(lines.length).toBe(31_004); // header, 31,000 rows, 3 footer lines
  });
});
