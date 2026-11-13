import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * feature-plan-large-report-responses.md §11 T12–T14: the detailed cost Excel's row cap (§6.4, Q1/Q2). 25,000 rows are
 * allowed and 25,001 refused with a 422 before any workbook is built; the no-hours 422 comes first; the Hours summary
 * is never capped. The workbook builders are spies, so no real 25,000-row workbook is built.
 */

const h = vi.hoisted(() => ({ detailed: [] as unknown[], summary: [] as unknown[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/rate-limit', () => ({ checkReportRateLimit: () => null }));
vi.mock('@/server/actions/reports', () => ({
  getDetailedCostReport: vi.fn(async () => h.detailed),
  getEmployeeSummaryReport: vi.fn(async () => h.summary),
}));
vi.mock('@/lib/session', () => ({ getSessionUser: async () => ({ role: 'admin' }), AuthorizationError: class AuthorizationError extends Error {} }));
vi.mock('@/lib/reports/cost-report-excel', () => ({
  generateCostReportExcel: vi.fn(async () => Buffer.from('PK-detailed')),
  generateEmployeeSummaryExcel: vi.fn(async () => Buffer.from('PK-summary')),
}));

import { GET as xlsxGET } from '@/app/api/reports/cost-report-xlsx/route';
import { generateCostReportExcel, generateEmployeeSummaryExcel } from '@/lib/reports/cost-report-excel';
import { EXCEL_COST_MAX_ROWS, EXCEL_COST_TOO_MANY_ROWS } from '@/lib/reports/limits';

const rows = (n: number, totalHours = 8) => Array.from({ length: n }, () => ({ totalHours, unpricedHours: 0 }));
const req = (q = '') => new NextRequest(`http://localhost/api/reports/cost-report-xlsx?startDate=2026-01-01&endDate=2026-12-31${q}`);

beforeEach(() => {
  vi.mocked(generateCostReportExcel).mockClear();
  vi.mocked(generateEmployeeSummaryExcel).mockClear();
});

describe('detailed cost Excel row cap (large-report-responses §6.4)', () => {
  it('T12: the cap is 25,000 and the message is the Q2 text, with the number formatted from the constant', () => {
    expect(EXCEL_COST_MAX_ROWS).toBe(25_000);
    expect(EXCEL_COST_TOO_MANY_ROWS).toBe('More than 25,000 rows match. Choose a shorter date range, or download the CSV.');
    expect(EXCEL_COST_TOO_MANY_ROWS).toContain(EXCEL_COST_MAX_ROWS.toLocaleString('en-US'));
  });

  it('T13: 25,000 rows → 200 and one workbook; 25,001 → 422 with the message and no workbook; 0-hour rows → the no-hours 422', async () => {
    h.detailed = rows(25_000);
    const ok = await xlsxGET(req());
    expect(ok.status).toBe(200);
    expect(generateCostReportExcel).toHaveBeenCalledTimes(1);

    vi.mocked(generateCostReportExcel).mockClear();
    h.detailed = rows(25_001);
    const over = await xlsxGET(req());
    expect(over.status).toBe(422);
    expect(await over.json()).toEqual({ error: EXCEL_COST_TOO_MANY_ROWS });
    expect(generateCostReportExcel).not.toHaveBeenCalled();

    h.detailed = rows(25_001, 0);
    const empty = await xlsxGET(req());
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({ error: 'No hours recorded between Jan 1 and Dec 31, 2026.' });
    expect(generateCostReportExcel).not.toHaveBeenCalled();
  });

  it('T14: the Hours summary is never capped (25,001 rows → 200)', async () => {
    h.summary = Array.from({ length: 25_001 }, (_, i) => ({
      employeeId: 'e' + i, employeeName: 'Emp ' + i, contractName: 'C', contractNumber: 'N', clinNumber: '0001', totalHours: 8, flsaExempt: false,
    }));
    const res = await xlsxGET(req('&format=summary'));
    expect(res.status).toBe(200);
    expect(generateEmployeeSummaryExcel).toHaveBeenCalledTimes(1);
  });
});
