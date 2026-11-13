import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-large-report-responses.md §11 T10, T11: /api/v1/costs through the REAL handleApiRequest (auth mocks as
 * v1-api-auth.test.ts:20-43). 15,000 rows stream past 4.5 MB in more than one chunk with the same JSON shape; a query
 * failure is still the generic JSON 500, reported to Sentry (it happens before any byte).
 */

const h = vi.hoisted(() => ({ rows: [] as unknown[], queryError: null as Error | null, captured: [] as unknown[] }));
const tenant = { slug: 'acme-test', dbUrl: 'postgres://tenant-db' };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenant/context', () => ({ getTenantState: async () => ({ kind: 'full', tenant }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: (e: unknown) => { h.captured.push(e); } }));

const validRow = {
  id: 'key-1', name: 'k', permissions: 'read', createdByUserId: 'u1', isActive: true, expiresAt: null,
  creatorRole: 'admin', creatorIsActive: true,
};
function fakeKeyDb() {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => [validRow],
  };
  return { select: () => chain, update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) };
}
vi.mock('@/db', () => ({ getDbForUrl: () => fakeKeyDb(), getDb: async () => fakeKeyDb() }));
vi.mock('@/server/internal/reports', () => ({
  getDetailedCostReportData: vi.fn(async () => { if (h.queryError) throw h.queryError; return h.rows; }),
}));

import { GET } from '@/app/api/v1/costs/route';
import type { CostReportEntry } from '@/server/internal/reports';

const KEY = `byt_${'b'.repeat(48)}`;
let ip = 0;
const request = () => new Request('https://acme-test.example.com/api/v1/costs?startDate=2026-01-01&endDate=2026-12-31', {
  headers: { Authorization: `Bearer ${KEY}`, 'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}` },
}) as never;

const entry = (i: number): CostReportEntry => ({
  employeeName: 'Emp ' + i, employeeEmail: `e${i}@x.test`, contractName: 'Contract', contractNumber: 'N-1', clinNumber: '0001',
  slinNumber: i % 3 ? null : 'S1', chargeCode: i % 5 ? 'CC-' + i : null, className: i % 4 ? 'Class' : null,
  lcatCode: 'SE2', lcatTitle: 'Engineer', hourlyRate: 100, totalHours: 8, totalCost: i % 9 ? 800 : 0, entryDate: '2026-03-02',
  costBasis: i % 9 ? 'priced' : 'unpriced', unpricedReason: i % 9 ? null : 'no-category', unpricedHours: i % 9 ? 0 : 8,
});

beforeEach(() => { h.rows = []; h.queryError = null; h.captured = []; });

describe('/api/v1/costs streams (large-report-responses §6.3)', () => {
  it('T10: 15,000 rows → 200, over 4.5 MB, more than one chunk, the same meta and every row', async () => {
    h.rows = Array.from({ length: 15_000 }, (_, i) => entry(i));
    const unpricedHours = Math.round(h.rows.reduce((s: number, r) => s + (r as CostReportEntry).unpricedHours, 0) * 100) / 100;
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const reader = res.body!.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const body = Buffer.concat(parts);
    expect(body.byteLength).toBeGreaterThan(4_500_000);
    expect(parts.length).toBeGreaterThan(1);
    const parsed = JSON.parse(body.toString('utf8'));
    expect(parsed.meta).toEqual({ timestamp: expect.any(String), total: 15000, unpricedHours });
    expect(parsed.data).toHaveLength(15_000);
    expect(parsed.data[14_999]).toEqual(entry(14_999));
  });

  it('T11: the query fails → 500 JSON { error: "Internal server error" }, reported to Sentry', async () => {
    h.queryError = new Error('connection reset');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(h.captured).toEqual([h.queryError]);
    spy.mockRestore();
  });
});
