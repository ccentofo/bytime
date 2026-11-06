import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-approvals-payroll.md §3.1.2 / A-2, unit companion to integration/period-flags.test.ts, runnable
 * without Postgres: periodFlags builds ONE query (built on drizzle.mock and recorded): per cell inside — the max app
 * revision, whether revision 1 (app) carried a reason, the latest revision's hours — then per (user, day). `source`
 * is in the aggregates' FILTERs, not the WHERE (imported hours count). Per-period sums are done in JS.
 */

const h = vi.hoisted(() => ({ built: [] as Array<{ toSQL: () => { sql: string } }>, rows: [] as unknown[] }));
vi.mock('server-only', () => ({}));

import { drizzle } from 'drizzle-orm/postgres-js';
import { periodFlags } from '@/server/internal/period-flags';

const mock = drizzle.mock();
const wrap = (b: object): object => new Proxy(b, {
  get(target, key) {
    if (key === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => { h.built.push(target as never); return Promise.resolve(h.rows).then(res, rej); };
    const v = (target as Record<PropertyKey, unknown>)[key];
    if (typeof v !== 'function') return v;
    return (...args: unknown[]) => { const r = (v as (...a: unknown[]) => unknown).apply(target, args); return r && typeof r === 'object' && 'toSQL' in r ? wrap(r) : r; };
  },
});
const db = { select: (...a: unknown[]) => wrap((mock.select as (...x: unknown[]) => object)(...a)) };
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('periodFlags (A-2 companion)', () => {
  it('one query: per cell inside, per (user, day) outside; source only in the FILTERs; hours from the latest revision', async () => {
    h.built = [];
    h.rows = [];
    await periodFlags(db as never, [{ id: 'p', userId: 'u', periodStart: '2026-09-01' as never, periodNumDays: 15, submissionCount: 1 }]);
    expect(h.built).toHaveLength(1);
    const s = flat(h.built[0].toSQL().sql);
    expect(s).toContain(`MAX("revision_number") FILTER (WHERE "source" = 'app') as "max_app_rev"`);
    expect(s).toContain(`BOOL_OR("revision_number" = 1 AND "source" = 'app' AND "change_reason_code" IS NOT NULL) as "late1"`);
    expect(s).toContain('(ARRAY_AGG("hours" ORDER BY "revision_number" DESC))[1] as "latest_hours"');
    expect(s).toContain('COUNT(*) FILTER (WHERE max_app_rev > 1)');
    expect(s).toContain('COUNT(*) FILTER (WHERE late1 AND max_app_rev = 1)');
    expect(s).toContain('SUM(latest_hours::numeric)');
    expect(s).toContain(') "c" group by "c"."user_id", "c"."entry_date"');
    expect(s).toContain('group by "timesheet_entries"."user_id", "timesheet_entries"."entry_date", COALESCE("timesheet_entries"."charge_code_id", "timesheet_entries"."indirect_code_id", "timesheet_entries"."clin_id")');
    const where = s.slice(s.indexOf(' where '), s.indexOf(' group by '));
    expect(where).not.toContain('source');
  });

  it("per period in JS: only that user's days inside the period; hours summed in cents", async () => {
    h.rows = [
      { userId: 'u', entryDate: '2026-09-01', corrections: 1, late: 0, hours: 0.1 },
      { userId: 'u', entryDate: '2026-09-15', corrections: 0, late: 2, hours: 0.2 },
      { userId: 'u', entryDate: '2026-09-16', corrections: 5, late: 5, hours: 8 },   // next period
      { userId: 'x', entryDate: '2026-09-02', corrections: 5, late: 5, hours: 8 },   // someone else
    ];
    const flags = await periodFlags(db as never, [{ id: 'p', userId: 'u', periodStart: '2026-09-01' as never, periodNumDays: 15, submissionCount: 3 }]);
    expect(flags.get('p')).toEqual({ corrections: 1, lateEntries: 2, resubmitted: true, hours: 0.3 });
  });
});
