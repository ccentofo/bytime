import { describe, it, expect, vi } from 'vitest';

/**
 * UX-4B1-AUDIT L14, unit companion to the integration case in integration/contracts-overview.test.ts, runnable without
 * Postgres: getContractsOverviewInternal's queries are built on drizzle.mock and recorded (not run). Both money
 * queries over timesheet_entries — per CLIN (clinCostTotals) and per SLIN — keep only the latest revision and
 * inner-join clins; the per-SLIN one groups by SLIN.
 */

const h = vi.hoisted(() => ({ built: [] as Array<{ toSQL: () => { sql: string } }> }));
vi.mock('server-only', () => ({}));

import { drizzle } from 'drizzle-orm/postgres-js';
import { getContractsOverviewInternal } from '@/server/internal/contracts-overview';

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
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('getContractsOverviewInternal SQL (L14)', () => {
  it('every money query over timesheet_entries keeps the latest revision and inner-joins clins', async () => {
    await getContractsOverviewInternal(db as never);
    const money = h.built.map((q) => flat(q.toSQL().sql)).filter((s) => s.includes('from "timesheet_entries"'));
    expect(money).toHaveLength(2);
    for (const s of money) {
      expect(s).toContain('SELECT MAX(te2.revision_number) FROM timesheet_entries te2');
      expect(s).toContain('inner join "clins" on "timesheet_entries"."clin_id" = "clins"."id"');
    }
    const perSlin = money.find((s) => s.includes('group by "timesheet_entries"."slin_id"'))!;
    expect(perSlin).toContain('"timesheet_entries"."slin_id" is not null');
    expect(perSlin).toContain('SELECT MAX(te2.revision_number)');
  });
});
