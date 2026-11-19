import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A3-D1, A3-D3, A3-D4 (unit; queries recorded on the real query builder, drizzle.mock, as in
 * cost-report-order-sql.test.ts):
 * - /api/v1/timesheets orders by name, date and the entry id (a total order, so pages never overlap or skip), and
 *   meta.total is a count of every match, not the page's length;
 * - /api/v1/timesheets refuses a bad page, pageSize or userId with 400 before any query; pageSize above 500 is capped;
 * - /api/v1/periods refuses an unknown status with 400 before any query.
 * The behaviour with real rows is in integration/v1-timesheets-paging.test.ts.
 */

type Built = { toSQL: () => { sql: string; params: unknown[] } };
const h = vi.hoisted(() => ({ built: [] as Built[], queue: [] as unknown[][] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  handleApiRequest: async (_req: Request, handler: () => Promise<Response>) => handler(),
}));
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const mock = drizzle.mock();
  const wrap = (b: object): object => new Proxy(b, {
    get(target, key) {
      if (key === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => { h.built.push(target as never); return Promise.resolve(h.queue.shift() ?? []).then(res, rej); };
      const v = (target as Record<PropertyKey, unknown>)[key];
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => { const r = (v as (...a: unknown[]) => unknown).apply(target, args); return r && typeof r === 'object' && 'toSQL' in r ? wrap(r) : r; };
    },
  });
  const db = { select: (...a: unknown[]) => wrap((mock.select as (...x: unknown[]) => object)(...a)) };
  return { getDb: async () => db };
});
vi.mock('@/server/internal/import-provenance', () => ({ importedPeriodIds: async () => new Set() }));
vi.mock('@/server/internal/approval-label', () => ({ approvalLabels: async () => new Map() }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => 'America/New_York' }));

import { GET as timesheetsGET } from '@/app/api/v1/timesheets/route';
import { GET as periodsGET } from '@/app/api/v1/periods/route';

const flat = (s: string) => s.replace(/\s+/g, ' ');
const timesheets = (qs: string) => timesheetsGET(new Request(`http://localhost/api/v1/timesheets?startDate=2026-10-01&endDate=2026-10-31${qs}`) as never);
const periods = (qs: string) => periodsGET(new Request(`http://localhost/api/v1/periods?${qs}`) as never);
const USER = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

beforeEach(() => { h.built = []; h.queue = []; });

describe('/api/v1/timesheets paging (A3-D1)', () => {
  it('orders by full name, entry date, then the entry id', async () => {
    h.queue = [[], [{ total: 0 }]];
    await timesheets('');
    const page = flat(h.built[0].toSQL().sql);
    const orderBy = page.slice(page.lastIndexOf(' order by ') + ' order by '.length);
    expect(orderBy.slice(0, orderBy.indexOf(' limit '))).toBe('"users"."full_name", "timesheet_entries"."entry_date", "timesheet_entries"."id"');
  });

  it('meta.total is the count of every match (same joins and conditions), not the page length', async () => {
    h.queue = [[{ id: 'e1' }, { id: 'e2' }], [{ total: 7 }]];
    const res = await timesheets(`&page=2&pageSize=2&userId=${USER}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta).toMatchObject({ total: 7, page: 2, pageSize: 2 });

    expect(h.built).toHaveLength(2);
    const [page, total] = h.built.map((q) => ({ sql: flat(q.toSQL().sql), params: q.toSQL().params }));
    expect(total.sql).toMatch(/^select count\(\*\) from "timesheet_entries" inner join "users" on "timesheet_entries"\."user_id" = "users"\."id" where /);
    expect(total.sql).not.toContain(' limit ');
    // Same WHERE as the page (dates, latest revision, the user), and the same parameters before limit/offset.
    const where = (s: string) => s.slice(s.indexOf(' where '), s.includes(' order by ') ? s.indexOf(' order by ') : undefined);
    expect(where(total.sql)).toBe(where(page.sql));
    expect(total.params).toEqual(page.params.slice(0, total.params.length));
    expect(total.params).toContain(USER);
    expect(page.params.slice(-2)).toEqual([2, 2]); // limit 2 offset 2
  });

  it('a pageSize above 500 is capped at 500, as before', async () => {
    h.queue = [[], [{ total: 0 }]];
    const body = await (await timesheets('&pageSize=1000')).json();
    expect(body.meta.pageSize).toBe(500);
  });
});

describe('bad parameters → 400 before any query (A3-D3, A3-D4)', () => {
  it.each([
    ['page=0', 'page must be a whole number of 1 or more.'],
    ['page=abc', 'page must be a whole number of 1 or more.'],
    ['page=1.5', 'page must be a whole number of 1 or more.'],
    ['page=-1', 'page must be a whole number of 1 or more.'],
    ['pageSize=0', 'pageSize must be a whole number of 1 or more.'],
    ['pageSize=ten', 'pageSize must be a whole number of 1 or more.'],
    ['userId=not-a-uuid', 'userId must be a valid UUID.'],
    ["userId=1'%20OR%201=1", 'userId must be a valid UUID.'],
  ])('/api/v1/timesheets %s', async (qs, message) => {
    const res = await timesheets(`&${qs}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
    expect(h.built).toEqual([]);
  });

  it('/api/v1/periods: an unknown status', async () => {
    const res = await periods('status=done');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'status must be one of: draft, submitted, approved, rejected.' });
    expect(h.built).toEqual([]);
  });

  it('/api/v1/periods: a known status filters by it', async () => {
    const res = await periods('status=approved');
    expect(res.status).toBe(200);
    expect(h.built).toHaveLength(1);
    expect(flat(h.built[0].toSQL().sql)).toContain('"timesheet_periods"."status" = $1');
    expect(h.built[0].toSQL().params).toEqual(['approved']);
  });
});
