import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * feature-plan-ux-page-fixes.md C15 (R5), unit companion to integration/report-routes.test.ts (T-C15c), runnable without
 * Postgres: the PDF route's Content-Disposition (RFC 6266 / 5987) for `Zoë "Z" O'Brien`, and a render or generation
 * failure in the PDF and CSV routes returning the JSON 500 (rendering is inside the try now).
 *
 * feature-plan-ux-kit-contracts.md R4 / R-3 (unit companion to integration/report-routes.test.ts): a range whose hours
 * total 0 (cleared-only included) → 422 { error } in the CSV and both Excel formats — "No hours recorded between …",
 * and "No direct hours …" for the summary (direct time only); the PDF keeps 404 for an unknown employee, with its own
 * message.
 */

const h = vi.hoisted(() => ({ failRender: false, failCsv: false, pdfData: null as unknown, detailed: [] as unknown[], summary: [] as unknown[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/rate-limit', () => ({ checkReportRateLimit: () => null }));
vi.mock('@/server/actions/reports', () => ({
  getTimesheetReportData: vi.fn(async () => h.pdfData),
  getDetailedCostReport: vi.fn(async () => h.detailed),
  getEmployeeSummaryReport: vi.fn(async () => h.summary),
}));
vi.mock('@/lib/session', () => ({ getSessionUser: async () => ({ role: 'admin' }), AuthorizationError: class AuthorizationError extends Error {} }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: vi.fn(async () => 'America/New_York') }));
vi.mock('@/lib/reports/timesheet-pdf', () => ({ TimesheetPdfDocument: () => null }));
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn(async () => { if (h.failRender) throw new Error('font missing'); return Buffer.from('%PDF'); }) }));
// large-report-responses §10.1: the route builds its lines with csvLines (before the stream), so that's what fails here.
vi.mock('@/lib/reports/csv-generator', () => ({
  generateCsv: vi.fn(() => { if (h.failCsv) throw new Error('bad row'); return 'a,b\n'; }),
  csvLines: vi.fn(() => { if (h.failCsv) throw new Error('bad row'); return ['a,b']; }),
}));

import { GET as pdfGET } from '@/app/api/reports/timesheet-pdf/route';
import { GET as csvGET } from '@/app/api/reports/cost-report-csv/route';
import { GET as xlsxGET } from '@/app/api/reports/cost-report-xlsx/route';
import { pdfContentDisposition } from '@/lib/content-disposition';

beforeEach(() => {
  h.failRender = false; h.failCsv = false;
  h.pdfData = { employee: { fullName: `Zoë "Z" O'Brien` } };
  h.detailed = [{ totalHours: 8, unpricedHours: 0 }];
  h.summary = [{ totalHours: 8 }];
});
const pdfReq = () => new NextRequest('http://localhost/api/reports/timesheet-pdf?userId=u1&periodStart=2026-10-16');
const csvReq = () => new NextRequest('http://localhost/api/reports/cost-report-csv?startDate=2026-10-01&endDate=2026-10-31');

describe('report routes (C15)', () => {
  it('the PDF Content-Disposition: an ASCII fallback with no quotes and a filename* with %C3%AB %22 %27', async () => {
    const res = await pdfGET(pdfReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="timesheet-Zo_-_Z_-O_Brien-2026-10-16.pdf"; filename*=UTF-8''timesheet-Zo%C3%AB-%22Z%22-O%27Brien-2026-10-16.pdf`,
    );
  });

  it('CR/LF and the RFC 5987 extras never survive either form', () => {
    const cd = pdfContentDisposition('Evil\r\nSet-Cookie: x (a*b)', '2026-10-16');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toContain('%28a%2Ab%29');
    expect(cd.match(/filename="([^"]*)"/)![1]).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('a PDF render failure → JSON 500', async () => {
    h.failRender = true;
    const res = await pdfGET(pdfReq());
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('a CSV generation failure → JSON 500', async () => {
    h.failCsv = true;
    const res = await csvGET(csvReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('empty ranges (R4, R-3 companion)', () => {
  const xlsxReq = (q: string) => new NextRequest(`http://localhost/api/reports/cost-report-xlsx?startDate=2026-10-16&endDate=2026-10-31${q}`);
  const COSTS = { error: 'No hours recorded between Oct 16 and Oct 31, 2026.' };

  it('Σ hours = 0 (no rows, or cleared-only rows of 0 hours) → 422 in the CSV and the detailed Excel', async () => {
    for (const rows of [[], [{ totalHours: 0, unpricedHours: 0 }, { totalHours: 0, unpricedHours: 0 }]]) {
      h.detailed = rows;
      const csv = await csvGET(new NextRequest('http://localhost/api/reports/cost-report-csv?startDate=2026-10-16&endDate=2026-10-31'));
      expect(csv.status).toBe(422);
      expect(await csv.json()).toEqual(COSTS);
      const xlsx = await xlsxGET(xlsxReq(''));
      expect(xlsx.status).toBe(422);
      expect(await xlsx.json()).toEqual(COSTS);
    }
  });

  it('the summary (direct time only): a leave-only range → 422 "No direct hours …"; hours → 200', async () => {
    h.summary = [];
    const res = await xlsxGET(xlsxReq('&format=summary'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'No direct hours recorded between Oct 16 and Oct 31, 2026.' });
    h.summary = [{ employeeId: 'e', employeeName: 'Pat', contractName: 'N', contractNumber: '1', clinNumber: '0001', totalHours: 8, flsaExempt: false }];
    expect((await xlsxGET(xlsxReq('&format=summary'))).status).toBe(200);
  });

  it('the PDF keeps 404 for an unknown employee, with its own message', async () => {
    h.pdfData = null;
    const res = await pdfGET(pdfReq());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "That employee wasn't found." });
  });

  it('across years the range names both years', async () => {
    h.detailed = [];
    const res = await csvGET(new NextRequest('http://localhost/api/reports/cost-report-csv?startDate=2025-12-16&endDate=2026-01-15'));
    expect(await res.json()).toEqual({ error: 'No hours recorded between Dec 16, 2025 and Jan 15, 2026.' });
  });
});
