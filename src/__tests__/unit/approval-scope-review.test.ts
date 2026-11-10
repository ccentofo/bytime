import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-approval-scope.md S6 / AS-13: the review list (getApprovalScopesView's `needsReview`) and Home's count
 * (approvalScopesToReview) use the SAME predicate — source 'migration', active, not reviewed — for ANY holder (no filter
 * on the holder's role or active state, so an inactive holder is counted and listed). Home's admin section still renders
 * when the count is 0, and the count runs after the main burst and setup's COUNTs.
 */

const h = vi.hoisted(() => ({ built: [] as Array<{ toSQL: () => { sql: string; params: unknown[] } }>, order: [] as string[], count: 0 }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ requireAdmin: async () => ({ id: 'a', role: 'admin' }), requireAdminFresh: async () => ({ id: 'a', role: 'admin' }) }));

import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';

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
vi.mock('@/db', () => ({ getDb: async () => db, getDbForWrite: async () => db }));

import { UNREVIEWED_MIGRATED_SCOPE, approvalScopesToReview } from '@/server/internal/approval-scopes';
import { getApprovalScopesView } from '@/server/actions/assignments';

const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/\$\d+/g, '$?');
const PREDICATE = flat(new PgDialect().sqlToQuery(UNREVIEWED_MIGRATED_SCOPE).sql);

beforeEach(() => { h.built = []; });

describe('one predicate for the review list and the Home count (AS-13)', () => {
  it('the predicate is source = migration, active, not reviewed — nothing about the holder', () => {
    expect(PREDICATE).toBe('("approval_scopes"."source" = $? and "approval_scopes"."is_active" = $? and "approval_scopes"."reviewed_at" is null)');
    expect(new PgDialect().sqlToQuery(UNREVIEWED_MIGRATED_SCOPE).params).toEqual(['migration', true]);
  });

  it('Home counts with exactly it; the review list flags rows with exactly it and never filters on the holder', async () => {
    await approvalScopesToReview(db as never);
    const count = h.built[0].toSQL();
    expect(flat(count.sql)).toBe(`select count(*) from "approval_scopes" where ${PREDICATE}`);
    expect(count.params).toEqual(['migration', true]);

    await getApprovalScopesView();
    const view = flat(h.built[1].toSQL().sql);
    expect(view).toContain(`(${PREDICATE})`);                                                // the needsReview column
    const where = view.slice(view.indexOf(' where '), view.indexOf(' order by '));
    expect(where).toBe(' where "approval_scopes"."is_active" = $?');                        // any holder: no users.* filter
    expect(view).toMatch(/inner join "users" on "users"\."id" = "approval_scopes"\."supervisor_id"/);
  });
});
