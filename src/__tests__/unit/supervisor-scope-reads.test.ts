import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A1-G15: three reads that must pass a supervisor's scope (lead-confirmed):
 * - the Audit trail CSV route: getEmployeeScope(actor) → the count/batch query is limited to those employees, and an
 *   empty scope reads nothing;
 * - getCellRevisionHistory: assertCanAccessEmployee(actor, userId) before any read;
 * - getTimesheetForReview: assertCanAccessEmployee(actor, employeeId) before any read.
 */

const SUP = { id: 'sup-1', email: 's@acme.test', fullName: 'Sam', role: 'supervisor' as const };
const h = vi.hoisted(() => ({
  scope: [] as string[] | 'all',
  wheres: [] as unknown[],
  dbReads: 0,
  denied: false,
  accessCalls: [] as Array<[unknown, string]>,
  scopeCalls: [] as unknown[],
}));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const sup = async () => ({ id: 'sup-1', email: 's@acme.test', fullName: 'Sam', role: 'supervisor' });
  return {
    AuthorizationError,
    requireSession: sup, requireApprover: sup, requireApproverFresh: sup, requireAdmin: sup, requireAdminFresh: sup,
    getEmployeeScope: async (actor: unknown) => { h.scopeCalls.push(actor); return h.scope; },
    assertCanAccessEmployee: async (actor: unknown, id: string) => {
      h.accessCalls.push([actor, id]);
      if (h.denied) throw new AuthorizationError('forbidden', 'Forbidden: not in your scope.');
    },
  };
});
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => 'America/New_York', getWorkspaceToday: async () => '2026-11-19' }));
vi.mock('@/db', () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const k of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'groupBy', 'for']) c[k] = () => c;
    c.where = (w: unknown) => { h.wheres.push(w); return c; };
    c.then = (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res);
    return c;
  };
  const db = { select: () => { h.dbReads++; return chain(); } };
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db };
});

import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { GET as auditCsv } from '@/app/api/reports/audit-csv/route';
import { getCellRevisionHistory } from '@/server/actions/audit';
import { getTimesheetForReview } from '@/server/actions/timesheet';

const EMP = '00000000-0000-4000-8000-000000000011';
const CELL = '00000000-0000-4000-8000-000000000022';
let ip = 0;
const csv = () => auditCsv(new NextRequest('https://acme.example.com/api/reports/audit-csv?start=2026-11-01&end=2026-11-15', {
  headers: { 'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}` },
}));

beforeEach(() => {
  h.scope = [];
  h.wheres = [];
  h.dbReads = 0;
  h.denied = false;
  h.accessCalls = [];
  h.scopeCalls = [];
});

describe('A1-G15: the Audit trail CSV passes the supervisor scope', () => {
  it("the count query is limited to the supervisor's employees", async () => {
    h.scope = ['emp-a', 'emp-b'];
    expect((await csv()).status).toBe(422); // the fake finds no rows
    expect(h.scopeCalls).toEqual([expect.objectContaining({ id: SUP.id, role: 'supervisor' })]);
    expect(h.wheres).toHaveLength(1);
    const q = new PgDialect().sqlToQuery(h.wheres[0] as SQL);
    expect(q.sql).toMatch(/"timesheet_entries"\."user_id" in \(\$1, \$2\)/);
    expect(q.params.slice(0, 2)).toEqual(['emp-a', 'emp-b']);
  });

  it('an empty scope reads nothing at all', async () => {
    h.scope = [];
    expect((await csv()).status).toBe(422);
    expect(h.wheres).toEqual([]);
  });

  it("an admin's 'all' adds no employee filter (control)", async () => {
    h.scope = 'all';
    await csv();
    expect(new PgDialect().sqlToQuery(h.wheres[0] as SQL).sql).not.toMatch(/"user_id" in/);
  });
});

describe('A1-G15: one-employee reads check access first', () => {
  it('getCellRevisionHistory: assertCanAccessEmployee(actor, userId), and a refusal reads nothing', async () => {
    await getCellRevisionHistory(EMP, CELL, '2026-11-03' as never);
    expect(h.accessCalls).toEqual([[expect.objectContaining({ id: SUP.id }), EMP]]);
    h.dbReads = 0;
    h.denied = true;
    await expect(getCellRevisionHistory(EMP, CELL, '2026-11-03' as never)).rejects.toThrow(/not in your scope/);
    expect(h.dbReads).toBe(0);
  });

  it('getTimesheetForReview: assertCanAccessEmployee(actor, employeeId), and a refusal reads nothing', async () => {
    h.denied = true;
    await expect(getTimesheetForReview(EMP, '2026-11-01' as never)).rejects.toThrow(/not in your scope/);
    expect(h.accessCalls).toEqual([[expect.objectContaining({ id: SUP.id }), EMP]]);
    expect(h.dbReads).toBe(0);
  });
});
