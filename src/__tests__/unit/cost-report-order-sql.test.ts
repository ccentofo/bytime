import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-excel-cost-report.md §11 T17 (§6.1 item 6): the detailed cost report's ORDER BY keys, rendered from the
 * real query builder (drizzle.mock, recorded on `then`, as in period-flags-sql.test.ts). Pins the tiebreakers that the
 * integration test T6 can only observe.
 */

const h = vi.hoisted(() => ({ built: [] as Array<{ toSQL: () => { sql: string } }> }));
vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const mock = drizzle.mock();
  const wrap = (b: object): object => new Proxy(b, {
    get(target, key) {
      if (key === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => { h.built.push(target as never); return Promise.resolve([]).then(res, rej); };
      const v = (target as Record<PropertyKey, unknown>)[key];
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => { const r = (v as (...a: unknown[]) => unknown).apply(target, args); return r && typeof r === 'object' && 'toSQL' in r ? wrap(r) : r; };
    },
  });
  const db = { select: (...a: unknown[]) => wrap((mock.select as (...x: unknown[]) => object)(...a)) };
  return { getDb: async () => db };
});

import { getDetailedCostReportData } from '@/server/internal/reports';

const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('getDetailedCostReportData ORDER BY (T17)', () => {
  it('orders by contract name then id, CLIN, employee name then id, date, charge code, entry id', async () => {
    h.built = [];
    await getDetailedCostReportData('2026-09-01' as never, '2026-09-30' as never);
    expect(h.built).toHaveLength(1);
    const s = flat(h.built[0].toSQL().sql);
    const orderBy = s.slice(s.lastIndexOf(' order by ') + ' order by '.length);
    expect(orderBy).toBe('"contracts"."name", "contracts"."id", "clins"."clin_number", "users"."full_name", "users"."id", "timesheet_entries"."entry_date", "report_cc"."code", "timesheet_entries"."id"');
    // the two new joins are LEFT joins (invariant 3)
    expect(s).toContain('left join "charge_codes" "report_cc" on "timesheet_entries"."charge_code_id" = "report_cc"."id"');
    expect(s).toContain('left join "cost_classes" "report_class" on "report_cc"."class_id" = "report_class"."id"');
  });
});

describe('getDetailedCostReportData contract filter (SWEEP-FINDINGS.md A3-G2)', () => {
  const UUID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  it('with a contract id: WHERE "contracts"."id" = $n, with that id as the parameter', async () => {
    h.built = [];
    await getDetailedCostReportData('2026-09-01' as never, '2026-09-30' as never, UUID);
    const q = (h.built[0] as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL();
    const where = flat(q.sql).slice(flat(q.sql).indexOf(' where '), flat(q.sql).lastIndexOf(' order by '));
    const m = where.match(/"contracts"\."id" = \$(\d+)/);
    expect(m).not.toBeNull();
    expect(q.params[Number(m![1]) - 1]).toBe(UUID);
  });

  it('without one: no contract condition', async () => {
    h.built = [];
    await getDetailedCostReportData('2026-09-01' as never, '2026-09-30' as never);
    const s = flat(h.built[0].toSQL().sql);
    expect(s.slice(s.indexOf(' where '), s.lastIndexOf(' order by '))).not.toContain('"contracts"."id" =');
  });
});
