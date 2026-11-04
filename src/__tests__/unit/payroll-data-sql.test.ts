import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-approvals-payroll.md §4.1.1 / P-1, unit companion: the people query reads every ENTRY user (names
 * and exemption for the file, as before) OR an active expected submitter (EXPECTED_SUBMITTER_ROLES), selecting
 * createdAt; the settings read carries the timezone (no extra query). Built on drizzle.mock and recorded.
 */

const h = vi.hoisted(() => ({ built: [] as Array<{ toSQL: () => { sql: string; params: unknown[] } }>, queue: [] as unknown[][] }));
vi.mock('server-only', () => ({}));

import { drizzle } from 'drizzle-orm/postgres-js';
import { loadPayrollData } from '@/server/internal/payroll-data';

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
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('loadPayrollData SQL (P-1 companion)', () => {
  it('settings with the timezone; people = entry users OR active expected submitters, with createdAt', async () => {
    h.queue = [
      [{ day: 1, timezone: 'America/New_York' }],
      [{ userId: 'u1', entryDate: '2026-10-05', hours: '8.00', clinId: 'c', indirectCode: null, indirectCategory: null, leavePayType: null }],
      [], [], [],
    ];
    await loadPayrollData(db as never, '2026-10-01' as never, '2026-10-15' as never);
    const sqls = h.built.map((q) => ({ sql: flat(q.toSQL().sql), params: q.toSQL().params }));
    expect(sqls[0].sql).toContain('select "workweek_start_day", "timezone" from "workspace_settings"');
    const people = sqls.find((q) => q.sql.includes('from "users"'))!;
    expect(people.sql).toContain('"created_at"');
    expect(people.sql).toMatch(/where \("users"\."id" in \(\$1\) or \("users"\."is_active" = \$2 and "users"\."role" in \(\$3, \$4\)\)\)/);
    expect(people.params).toEqual(['u1', true, 'employee', 'supervisor']);
    expect(h.built.filter((q) => flat(q.toSQL().sql).includes('workspace_settings'))).toHaveLength(1);
  });
});
