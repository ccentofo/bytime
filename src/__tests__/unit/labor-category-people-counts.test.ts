import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-kit-contracts.md §4.2 / L-1, unit companion to integration/labor-categories.test.ts (the counts on real
 * rows), runnable without Postgres: getLaborCategoryPeopleCounts guards first, builds ONE grouped COUNT(DISTINCT
 * user_id) over assignments active on the workspace today (effective ≤ today; no end or end ≥ today — inclusive), and
 * returns numbers keyed by category. The query is built on drizzle.mock and rendered, not run.
 */

const h = vi.hoisted(() => ({ calls: [] as string[], built: [] as Array<{ toSQL: () => { sql: string; params: unknown[] } }>, rows: [] as unknown[] }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/lib/session', () => ({
  requireAdmin: vi.fn(async () => { h.calls.push('guard'); return { id: 'a', role: 'admin' }; }),
  requireAdminFresh: vi.fn(),
}));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => '2026-11-03' }));
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const mock = drizzle.mock();
  // Every builder in the chain is wrapped; awaiting it records the final query and resolves to the scripted rows.
  const wrap = (b: object): object => new Proxy(b, {
    get(target, key) {
      if (key === 'then') {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          h.calls.push('query');
          h.built.push(target as never);
          return Promise.resolve(h.rows).then(res, rej);
        };
      }
      const v = (target as Record<PropertyKey, unknown>)[key];
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown).apply(target, args);
        return r && typeof r === 'object' && 'toSQL' in r ? wrap(r) : r;
      };
    },
  });
  const db = { select: (...a: unknown[]) => wrap((mock.select as (...x: unknown[]) => object)(...a)) };
  return { getDb: async () => db, getDbForWrite: async () => db };
});

import { getLaborCategoryPeopleCounts } from '@/server/actions/labor-categories';

const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('getLaborCategoryPeopleCounts (L-1)', () => {
  it('guards first, one grouped COUNT(DISTINCT user_id) of assignments active today, numbers keyed by category', async () => {
    h.rows = [{ laborCategoryId: 'lc-1', people: '2' }, { laborCategoryId: 'lc-2', people: 1 }];
    expect(await getLaborCategoryPeopleCounts()).toEqual({ 'lc-1': 2, 'lc-2': 1 });
    expect(h.calls).toEqual(['guard', 'query']);
    const { sql, params } = h.built[0].toSQL();
    const s = flat(sql);
    expect(s).toContain('count(distinct "user_id")');
    expect(s).toContain('from "user_labor_categories"');
    expect(s).toContain('where ("user_labor_categories"."effective_date" <= $1 and ("user_labor_categories"."end_date" is null or "user_labor_categories"."end_date" >= $2))');
    expect(s).toContain('group by "user_labor_categories"."labor_category_id"');
    expect(params).toEqual(['2026-11-03', '2026-11-03']);
  });
});
