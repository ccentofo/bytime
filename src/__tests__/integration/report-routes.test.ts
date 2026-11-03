import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { todayIn } from '@/lib/calendar-date';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode } from './helpers';

/**
 * feature-plan-ux-page-fixes.md C15 (R5) / T-C15c: the timesheet PDF route against the real database. A name like
 * `Zoë "Z" O'Brien` gets an RFC 5987 filename* (with %27, %22 and %C3%AB) and an ASCII fallback with no quotes and no
 * CR/LF; a render failure returns the JSON 500 (rendering is inside the try now), not Next's HTML error.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
const h = vi.hoisted(() => ({ adminId: '', failRender: false }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const admin = async () => ({ id: h.adminId, email: 'admin@x', fullName: 'Admin', role: 'admin' });
  return { ...actual, requireSession: admin, requireAdmin: admin, requireApprover: admin, getSessionUser: admin, assertCanAccessEmployee: async () => {} };
});
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return { ...actual, renderToBuffer: async (...a: Parameters<typeof actual.renderToBuffer>) => { if (h.failRender) throw new Error('font missing'); return actual.renderToBuffer(...a); } };
});

import { GET } from '@/app/api/reports/timesheet-pdf/route';
import { GET as csvGET } from '@/app/api/reports/cost-report-csv/route';
import { GET as xlsxGET } from '@/app/api/reports/cost-report-xlsx/route';

describe('timesheet PDF route (C15, T-C15c)', () => {
  let employeeId: string;
  const periodStart = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
  const request = (ip: string) => new NextRequest(`http://localhost/api/reports/timesheet-pdf?userId=${employeeId}&periodStart=${periodStart}`, { headers: { 'x-forwarded-for': ip } });

  beforeEach(async () => {
    await cleanupTestData();
    h.failRender = false;
    h.adminId = (await createTestUser({ role: 'admin' })).id;
    employeeId = (await createTestUser({ role: 'employee', fullName: `Zoë "Z" O'Brien` })).id;
  });
  afterEach(async () => { h.failRender = false; await cleanupTestData(); });

  it('a name with an accent, quotes and an apostrophe → filename* with %C3%AB %22 %27, an ASCII fallback with no quotes or CR/LF', async () => {
    const res = await GET(request('203.0.113.71'));
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition')!;
    const star = cd.match(/filename\*=UTF-8''(\S+)$/)![1];
    expect(star).toContain('%C3%AB');
    expect(star).toContain('%22');
    expect(star).toContain('%27');
    expect(decodeURIComponent(star)).toBe(`timesheet-Zoë-"Z"-O'Brien-${periodStart}.pdf`);
    const ascii = cd.match(/filename="([^"]*)"/)![1];
    expect(ascii).toBe(`timesheet-Zo_-_Z_-O_Brien-${periodStart}.pdf`);
    expect(cd).not.toMatch(/[\r\n]/);
  });

  it('a render failure → JSON 500, not an HTML error page', async () => {
    h.failRender = true;
    const res = await GET(request('203.0.113.72'));
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});

/**
 * feature-plan-ux-kit-contracts.md R4 / R-3: the existing cost routes on a range whose hours total 0 → 422 { error }
 * (a cleared-only range included: the latest revision is 0 hours); a leave-only range on the summary → 422 with the
 * "direct hours" wording (it counts direct time only); the PDF keeps 404 for an unknown employee, with its message.
 */
describe('empty ranges (R4, R-3)', () => {
  const url = (route: string, q: string, ip: string) => new NextRequest(`http://localhost/api/reports/${route}?startDate=2026-10-16&endDate=2026-10-31${q}`, { headers: { 'x-forwarded-for': ip } });
  let employeeId: string;

  beforeEach(async () => {
    await cleanupTestData();
    h.adminId = (await createTestUser({ role: 'admin' })).id;
    employeeId = (await createTestUser({ role: 'employee' })).id;
  });
  afterEach(async () => { await cleanupTestData(); });

  it('a cleared-only range → 422 in the CSV, the detailed Excel and the summary', async () => {
    const clin = await createTestClin((await createTestContract()).id);
    const code = await createTestChargeCode(clin.id);
    await getTestDb().insert(schema.timesheetEntries).values([
      { userId: employeeId, createdBy: employeeId, chargeCodeId: code.id, clinId: clin.id, entryDate: '2026-10-20', hours: '8', revisionNumber: 1 },
      { userId: employeeId, createdBy: employeeId, chargeCodeId: code.id, clinId: clin.id, entryDate: '2026-10-20', hours: '0', revisionNumber: 2 },
    ]);
    const costs = { error: 'No hours recorded between Oct 16 and Oct 31, 2026.' };
    const csv = await csvGET(url('cost-report-csv', '', '203.0.113.81'));
    expect([csv.status, await csv.json()]).toEqual([422, costs]);
    const xlsx = await xlsxGET(url('cost-report-xlsx', '', '203.0.113.82'));
    expect([xlsx.status, await xlsx.json()]).toEqual([422, costs]);
    const summary = await xlsxGET(url('cost-report-xlsx', '&format=summary', '203.0.113.83'));
    expect([summary.status, await summary.json()]).toEqual([422, { error: 'No direct hours recorded between Oct 16 and Oct 31, 2026.' }]);
  });

  it('a leave-only range on the summary → 422 "No direct hours …"; with direct hours → 200', async () => {
    const leave = await createTestIndirectCode();
    await getTestDb().insert(schema.timesheetEntries).values({ userId: employeeId, createdBy: employeeId, indirectCodeId: leave.id, entryDate: '2026-10-21', hours: '8', revisionNumber: 1 });
    const res = await xlsxGET(url('cost-report-xlsx', '&format=summary', '203.0.113.84'));
    expect([res.status, await res.json()]).toEqual([422, { error: 'No direct hours recorded between Oct 16 and Oct 31, 2026.' }]);
    const clin = await createTestClin((await createTestContract()).id);
    const code = await createTestChargeCode(clin.id);
    await getTestDb().insert(schema.timesheetEntries).values({ userId: employeeId, createdBy: employeeId, chargeCodeId: code.id, clinId: clin.id, entryDate: '2026-10-22', hours: '4', revisionNumber: 1 });
    expect((await xlsxGET(url('cost-report-xlsx', '&format=summary', '203.0.113.85'))).status).toBe(200);
  });

  it('the PDF: an unknown employee keeps 404, with its message', async () => {
    const res = await GET(new NextRequest('http://localhost/api/reports/timesheet-pdf?userId=9f2c4c8e-0000-4000-8000-000000000000&periodStart=2026-10-16', { headers: { 'x-forwarded-for': '203.0.113.86' } }));
    expect([res.status, await res.json()]).toEqual([404, { error: "That employee wasn't found." }]);
  });
});
