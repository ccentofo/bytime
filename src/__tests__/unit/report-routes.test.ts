import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * feature-plan-ux-page-fixes.md C15 (R5), unit companion to integration/report-routes.test.ts (T-C15c), runnable without
 * Postgres: the PDF route's Content-Disposition (RFC 6266 / 5987) for `Zoë "Z" O'Brien`, and a render or generation
 * failure in the PDF and CSV routes returning the JSON 500 (rendering is inside the try now).
 */

const h = vi.hoisted(() => ({ failRender: false, failCsv: false }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/rate-limit', () => ({ checkReportRateLimit: () => null }));
vi.mock('@/server/actions/reports', () => ({
  getTimesheetReportData: vi.fn(async () => ({ employee: { fullName: `Zoë "Z" O'Brien` } })),
  getDetailedCostReport: vi.fn(async () => [{ unpricedHours: 0 }]),
}));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: vi.fn(async () => 'America/New_York') }));
vi.mock('@/lib/reports/timesheet-pdf', () => ({ TimesheetPdfDocument: () => null }));
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn(async () => { if (h.failRender) throw new Error('font missing'); return Buffer.from('%PDF'); }) }));
vi.mock('@/lib/reports/csv-generator', () => ({ generateCsv: vi.fn(() => { if (h.failCsv) throw new Error('bad row'); return 'a,b\n'; }) }));

import { GET as pdfGET } from '@/app/api/reports/timesheet-pdf/route';
import { GET as csvGET } from '@/app/api/reports/cost-report-csv/route';
import { pdfContentDisposition } from '@/lib/content-disposition';

beforeEach(() => { h.failRender = false; h.failCsv = false; });
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
