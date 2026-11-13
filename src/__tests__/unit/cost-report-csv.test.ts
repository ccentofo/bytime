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
import { CURRENT_CLASS_NOTE } from '@/lib/cost-labels';
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
