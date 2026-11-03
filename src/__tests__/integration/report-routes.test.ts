import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { todayIn } from '@/lib/calendar-date';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';

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
