import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-certified-outputs.md C2: approvalLabel (one helper, "Self-approved" everywhere), the self-approval
 * switch (recomputeSelfApproval writes enabled/disabled with the active-admin count), approve/reject order + "approve
 * exactly what was reviewed" (seen / submission_count), the self-approval event's approval_context, and the static
 * rules (every role/is_active/approver_id writer recomputes; nobody else formats the approver line).
 */

const h = vi.hoisted(() => ({ actor: null as null | { id: string; role: string; email: string; fullName: string } }));

vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb() as ReturnType<typeof createFakeControlDb> & { transaction: (cb: (tx: unknown) => unknown) => unknown };
  db.transaction = async (cb) => cb(db);
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const current = async () => {
    if (!h.actor) throw new AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return h.actor;
  };
  return {
    AuthorizationError,
    requireSession: current, requireApprover: current, requireApproverFresh: current, requireAdmin: current, requireAdminFresh: current,
    getEmployeeScope: async () => 'all', assertCanAccessEmployee: async () => {},
  };
});
vi.mock('@/lib/email/send', () => ({ sendTimesheetApprovedEmail: vi.fn(), sendTimesheetRejectedEmail: vi.fn(), sendTimesheetSubmittedEmail: vi.fn() }));
vi.mock('@/lib/email/schedule', () => ({ scheduleEmail: vi.fn() }));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'acme' }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => 'UTC', getWorkspaceToday: async () => '2026-10-25' }));

import * as dbModule from '@/db';
import { adminChangeLog, periodEvents, timesheetPeriods, userAssignments, users } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { approvalLabel, type ApprovalLabelEvent } from '@/server/internal/approval-label';
import { currentSelfApprovalOn, recomputeSelfApproval } from '@/server/internal/approval-rules';
import { approvePeriod, rejectPeriod } from '@/server/actions/periods';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
const T = new Date('2026-10-20T15:00:00Z');

beforeEach(() => { db.reset(); h.actor = null; });

// ── approvalLabel ─────────────────────────────────────────────────────────────
describe('approvalLabel — the one formatter', () => {
  const period = (o: Record<string, unknown> = {}) => ({ id: 'p1', userId: 'emp', status: 'approved', reviewedBy: 'boss', reviewedAt: T, ...o });
  const ev = (o: Partial<ApprovalLabelEvent> = {}): ApprovalLabelEvent => ({
    periodId: 'p1', event: 'approved', actorId: 'boss', source: 'app', originalMetadata: null, createdAt: T, importSourceSystem: null, importedAt: null, ...o,
  });
  const names = (id: string) => ({ boss: 'Pat Boss', emp: 'Jo Emp' } as Record<string, string>)[id] ?? null;

  it('in-app approval: approver name and date', () => {
    expect(approvalLabel(period(), [ev()], names, 'UTC')).toMatchObject({ kind: 'approved', selfApproved: false, badge: null, text: expect.stringMatching(/^Approved by Pat Boss on Oct 20, 2026/), approverName: 'Pat Boss' });
  });

  it('self-approval and self-rejection are labelled', () => {
    expect(approvalLabel(period({ reviewedBy: 'emp' }), [ev({ actorId: 'emp' })], names, 'UTC'))
      .toMatchObject({ kind: 'self-approved', selfApproved: true, badge: 'Self-approved', text: expect.stringMatching(/^Self-approved on Oct 20, 2026/) });
    expect(approvalLabel(period({ status: 'rejected', reviewedBy: 'emp' }), [ev({ event: 'rejected', actorId: 'emp' })], names, 'UTC'))
      .toMatchObject({ kind: 'self-rejected', selfApproved: false, badge: 'Self-rejected' });
  });

  it('legacy periods with no events fall back to reviewedBy (self too)', () => {
    expect(approvalLabel(period({ reviewedBy: 'emp' }), [], names, 'UTC').badge).toBe('Self-approved');
    expect(approvalLabel(period(), [], names, 'UTC').text).toMatch(/^Approved by Pat Boss on Oct 20, 2026/);
  });

  it('imported approval: source system, original reviewer and dates — never a CadenzPoint user', () => {
    const imported = ev({ actorId: 'admin', source: 'migration', originalMetadata: { reviewer: 'sarah@old.example', reviewedAt: '2025-06-17T14:00:00Z' }, importSourceSystem: 'Deltek', importedAt: new Date('2026-10-01T09:00:00Z') });
    expect(approvalLabel(period({ reviewedBy: null }), [imported], names, 'UTC')).toEqual({
      kind: 'imported-approved', selfApproved: false, badge: null, approverName: null,
      text: 'Approved in Deltek by sarah@old.example on 2025-06-17T14:00:00Z (imported 2026-10-01)',
    });
  });

  it('undecided periods have no line; a rejected period never reads as approved', () => {
    expect(approvalLabel(period({ status: 'submitted' }), [], names, 'UTC')).toMatchObject({ kind: 'none', text: null });
    expect(approvalLabel(period({ status: 'rejected' }), [ev({ event: 'rejected' })], names, 'UTC').text).toMatch(/^Rejected by Pat Boss on Oct 20, 2026/);
  });
});

// ── self-approval switch ──────────────────────────────────────────────────────
describe('recomputeSelfApproval', () => {
  const user = (id: string, role: string, o: Record<string, unknown> = {}) => ({ id, role, isActive: true, approverId: null, ...o });
  const logRow = (entityId: string, action: 'enabled' | 'disabled', at = T) => ({ id: `log-${entityId}-${action}`, entityId, action, actorId: 'x', createdAt: at, entity: 'self_approval' });

  it('deactivating the second admin writes self_approval enabled with activeAdminCount 1', async () => {
    db.onSelect(users, [user('a', 'admin'), user('b', 'admin', { isActive: false })]);
    db.onSelect(adminChangeLog, [logRow('a', 'disabled')]);
    db.onReturning('insert', adminChangeLog, [{ id: 'log-new' }]);
    const changes = await recomputeSelfApproval(db as never, 'a', 'admin B deactivated');
    expect(changes.map((c) => [c.adminId, c.enabled])).toEqual([['a', true]]);
    const written = db.inserts.filter((i) => i.table === adminChangeLog).map((i) => i.values);
    expect(written).toEqual([{ actorId: 'a', entity: 'self_approval', entityId: 'a', action: 'enabled', oldValue: { enabled: false }, newValue: { enabled: true, reason: 'admin B deactivated', activeAdminCount: 1 } }]);
  });

  it('with an active designee nothing is enabled', async () => {
    db.onSelect(users, [user('a', 'admin', { approverId: 'book' }), user('book', 'supervisor'), user('b', 'admin', { isActive: false })]);
    db.onSelect(adminChangeLog, [logRow('a', 'disabled')]);
    expect(await recomputeSelfApproval(db as never, 'a', 'admin B deactivated')).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it('reactivating an admin or designating someone writes disabled', async () => {
    db.onSelect(users, [user('a', 'admin', { approverId: 'book' }), user('book', 'supervisor')]);
    db.onSelect(adminChangeLog, [logRow('a', 'enabled')]);
    db.onReturning('insert', adminChangeLog, [{ id: 'log-new' }]);
    const changes = await recomputeSelfApproval(db as never, 'a', 'designee set');
    expect(changes.map((c) => [c.adminId, c.enabled])).toEqual([['a', false]]);
    expect(db.inserts[0].values).toMatchObject({ action: 'disabled', newValue: { enabled: false, activeAdminCount: 1 } });
  });

  it('a demoted admin whose last state was enabled is switched off', async () => {
    db.onSelect(users, [user('a', 'supervisor'), user('b', 'admin')]);
    db.onSelect(adminChangeLog, [logRow('a', 'enabled')]);
    db.onReturning('insert', adminChangeLog, [{ id: 'log-a' }]);
    db.onReturning('insert', adminChangeLog, [{ id: 'log-b' }]);
    const changes = await recomputeSelfApproval(db as never, 'b', "a's role changed");
    // a: was enabled, now not an admin → disabled. b: the sole active admin, never recorded → enabled.
    expect(changes).toEqual([{ adminId: 'a', enabled: false, logId: 'log-a' }, { adminId: 'b', enabled: true, logId: 'log-b' }]);
  });

  it('no change → no row (idempotent)', async () => {
    db.onSelect(users, [user('a', 'admin')]);
    db.onSelect(adminChangeLog, [logRow('a', 'enabled')]);
    expect(await recomputeSelfApproval(db as never, 'a', 'name edited')).toEqual([]);
  });
});

// ── approve / reject ──────────────────────────────────────────────────────────
describe('approve / reject order and "approve exactly what was reviewed"', () => {
  const submitted = (o: Record<string, unknown> = {}) => ({ id: 'p1', userId: 'emp', status: 'submitted', submissionCount: 2, periodStart: '2026-10-01', periodNumDays: 15, completenessSnapshot: null, ...o });
  const facts = (...rows: Array<Record<string, unknown>>) => db.onSelect(users, rows.map((r) => ({ isActive: true, approverId: null, ...r })));

  it('a missing `seen` is refused before anything is read', async () => {
    h.actor = { id: 'adm', role: 'admin', email: 'a@x', fullName: 'A' };
    const r = await approvePeriod({ periodId: 'p1' } as never);
    expect(r).toMatchObject({ ok: false, code: 'validation', error: expect.stringMatching(/reviewed version is missing/) });
  });

  it('stale version: resubmitted after the reviewer opened it → "resubmitted"; someone else decided → "just changed"', async () => {
    h.actor = { id: 'adm', role: 'admin', email: 'a@x', fullName: 'A' };
    db.onSelect(timesheetPeriods, [submitted()]);
    facts({ id: 'adm', role: 'admin' }, { id: 'emp', role: 'employee' });
    facts({ id: 'adm', role: 'admin' }, { id: 'emp', role: 'employee' }); // F1: re-read under the shared lock
    db.onReturning('update', timesheetPeriods, []);                       // conditional UPDATE matched nothing
    db.onSelect(timesheetPeriods, [{ status: 'submitted', submissionCount: 3 }]); // re-read: resubmitted
    expect(await approvePeriod({ periodId: 'p1', seen: 2 })).toEqual({ ok: false, code: 'conflict', error: 'This timesheet was resubmitted after you opened it — refresh to review the new version.' });

    db.reset();
    db.onSelect(timesheetPeriods, [submitted()]);
    facts({ id: 'adm', role: 'admin' }, { id: 'emp', role: 'employee' });
    facts({ id: 'adm', role: 'admin' }, { id: 'emp', role: 'employee' }); // F1: re-read under the shared lock
    db.onReturning('update', timesheetPeriods, []);
    db.onSelect(timesheetPeriods, [{ status: 'approved', submissionCount: 2 }]);
    expect(await rejectPeriod({ periodId: 'p1', seen: 2, comment: 'x' })).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/just changed by someone else/) });
  });

  it('the UPDATE is conditional on status = submitted AND submission_count = seen', async () => {
    h.actor = { id: 'adm', role: 'admin', email: 'a@x', fullName: 'A' };
    db.onSelect(timesheetPeriods, [submitted()]);
    facts({ id: 'adm', role: 'admin' }, { id: 'emp', role: 'employee' });
    facts({ id: 'adm', role: 'admin' }, { id: 'emp', role: 'employee' }); // F1: re-read under the shared lock
    db.onReturning('update', timesheetPeriods, [{ id: 'p1' }]);
    expect(await approvePeriod({ periodId: 'p1', seen: 2 })).toEqual({ ok: true, data: undefined });
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const q = new PgDialect().sqlToQuery(db.updates.find((u) => u.table === timesheetPeriods)!.where as never);
    expect(q.sql).toContain('"timesheet_periods"."status" = $2');
    expect(q.sql).toContain('"timesheet_periods"."submission_count" = $3');
    expect(q.params).toEqual(['p1', 'submitted', 2]);
  });

  it('non-admin self → the existing explicit refusal; admin self with a second active admin → the explicit message', async () => {
    h.actor = { id: 'sup', role: 'supervisor', email: 's@x', fullName: 'S' };
    db.onSelect(timesheetPeriods, [submitted({ userId: 'sup' })]);
    expect(await approvePeriod({ periodId: 'p1', seen: 2 })).toMatchObject({ ok: false, code: 'forbidden', error: 'Forbidden: You cannot approve your own timesheet.' });

    db.reset();
    h.actor = { id: 'adm', role: 'admin', email: 'a@x', fullName: 'A' };
    db.onSelect(timesheetPeriods, [submitted({ userId: 'adm' })]);
    facts({ id: 'adm', role: 'admin' }, { id: 'adm2', role: 'admin' });
    expect(await approvePeriod({ periodId: 'p1', seen: 2 })).toMatchObject({ ok: false, code: 'forbidden', error: 'Your timesheet must be approved by another admin or your designated approver.' });

    db.reset();
    db.onSelect(timesheetPeriods, [submitted({ userId: 'adm' })]);
    facts({ id: 'adm', role: 'admin', approverId: 'book' }, { id: 'book', role: 'supervisor' });
    expect(await approvePeriod({ periodId: 'p1', seen: 2 })).toMatchObject({ ok: false, error: 'Your timesheet must be approved by another admin or your designated approver.' });
  });

  it('canApprove false → "not found" (no disclosure): a peer supervisor', async () => {
    h.actor = { id: 'supA', role: 'supervisor', email: 's@x', fullName: 'S' };
    db.onSelect(timesheetPeriods, [submitted({ userId: 'supB' })]);
    facts({ id: 'supA', role: 'supervisor' }, { id: 'supB', role: 'supervisor' });
    db.onSelect(userAssignments, [{ userId: 'supA', clinId: 'c1' }, { userId: 'supB', clinId: 'c1' }]);
    expect(await approvePeriod({ periodId: 'p1', seen: 2 })).toEqual({ ok: false, code: 'not_found', error: 'Period not found' });
  });

  it('F1: the decision transaction takes the user-rules lock SHARED first and re-checks canApprove under it', async () => {
    h.actor = { id: 'book', role: 'supervisor', email: 'b@x', fullName: 'B' };
    db.onSelect(timesheetPeriods, [submitted({ userId: 'X' })]);
    facts({ id: 'book', role: 'supervisor' }, { id: 'X', role: 'supervisor', approverId: 'book' });   // fail-fast: book is X's designee
    facts({ id: 'book', role: 'employee' }, { id: 'X', role: 'supervisor', approverId: 'book' });     // under the lock: book was demoted meanwhile
    db.onReturning('update', timesheetPeriods, [{ id: 'p1' }]);
    expect(await approvePeriod({ periodId: 'p1', seen: 2 })).toEqual({ ok: false, code: 'not_found', error: 'Period not found' });
    expect(db.updates.filter((u) => u.table === timesheetPeriods)).toEqual([]);
    const { PgDialect } = await import('drizzle-orm/pg-core');
    expect(db.executes.map((q) => { const r = new PgDialect().sqlToQuery(q as never); return { sql: r.sql, params: r.params }; })).toEqual([{ sql: 'SELECT pg_advisory_xact_lock_shared(hashtext($1))', params: ['user-rules'] }]);
  });

  it('F1: an admin whose self-approval switched off while waiting is refused under the lock', async () => {
    h.actor = { id: 'adm', role: 'admin', email: 'a@x', fullName: 'A' };
    db.onSelect(timesheetPeriods, [submitted({ userId: 'adm' })]);
    facts({ id: 'adm', role: 'admin' });
    facts({ id: 'adm', role: 'admin' }, { id: 'adm2', role: 'admin' });
    expect(await approvePeriod({ periodId: 'p1', seen: 2 })).toMatchObject({ ok: false, code: 'forbidden', error: 'Your timesheet must be approved by another admin or your designated approver.' });
  });

  it('a self-approval event carries approval_context (activeAdminCount, enabledAt/By)', async () => {
    h.actor = { id: 'adm', role: 'admin', email: 'a@x', fullName: 'A' };
    db.onSelect(timesheetPeriods, [submitted({ userId: 'adm' })]);
    facts({ id: 'adm', role: 'admin' });                                // decide: facts (fail fast)
    facts({ id: 'adm', role: 'admin' });                                // decide: facts under the shared lock (F1)
    db.onReturning('update', timesheetPeriods, [{ id: 'p1' }]);
    facts({ id: 'adm', role: 'admin' });                                // selfApprovalContext: facts
    db.onSelect(adminChangeLog, [{ createdAt: T, actorId: 'adm' }]);
    expect((await approvePeriod({ periodId: 'p1', seen: 2 })).ok).toBe(true);
    const event = db.inserts.find((i) => i.table === periodEvents)!.values;
    expect(event).toMatchObject({ event: 'approved', actorId: 'adm', approvalContext: {
      selfApproved: true, activeAdminCount: 1, effectiveDesignee: null, selfApprovalEnabledAt: T.toISOString(), selfApprovalEnabledBy: 'adm',
    } });
  });
});

describe('F2 — "self-approval is back on" notice', () => {
  const sole = () => db.onSelect(users, [{ id: 'adm', role: 'admin', isActive: true, approverId: null }]);
  const log = (...rows: Array<{ action: string; reason: string }>) => db.onSelect(adminChangeLog, rows.map((r, i) => ({ id: `l${i}`, action: r.action, createdAt: T, newValue: { enabled: r.action === 'enabled', reason: r.reason } })));

  it('shows when the latest row is enabled and not a baseline — no earlier "disabled" row needed (pre-C2 workspaces)', async () => {
    sole();
    log({ action: 'enabled', reason: 'Second Admin deactivated' });
    expect(await currentSelfApprovalOn(db as never, 'adm')).toEqual({ logId: 'l0', at: T });
  });

  it('hidden for a baseline row (provisioning / demo seed), a latest "disabled" row, or when self-approval is not available', async () => {
    for (const reason of ['workspace created', 'demo workspace seeded']) {
      db.reset();
      sole();
      log({ action: 'enabled', reason });
      expect(await currentSelfApprovalOn(db as never, 'adm'), reason).toBeNull();
    }
    db.reset();
    sole();
    log({ action: 'enabled', reason: 'x deactivated' }, { action: 'disabled', reason: 'y added' });
    expect(await currentSelfApprovalOn(db as never, 'adm')).toBeNull();
    db.reset();
    db.onSelect(users, [{ id: 'adm', role: 'admin', isActive: true, approverId: null }, { id: 'adm2', role: 'admin', isActive: true, approverId: null }]);
    expect(await currentSelfApprovalOn(db as never, 'adm')).toBeNull();
  });
});

// ── static rules ──────────────────────────────────────────────────────────────
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The text of the function (declaration or arrow assigned to a const) that contains `index`. */
function enclosingFunction(src: string, index: number): { name: string; body: string } {
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^()]*\)\s*(?::[^=]+)?=>/g;
  let best: { name: string; start: number } | null = null;
  for (const m of src.matchAll(re)) {
    if (m.index! > index) break;
    best = { name: m[1] ?? m[2], start: m.index! };
  }
  if (!best) return { name: '(module)', body: src };
  const next = [...src.matchAll(re)].find((m) => m.index! > best!.start);
  return { name: best.name, body: src.slice(best.start, next ? next.index : undefined) };
}

/** Functions in src/ that insert users, or update users with role / isActive / approverId (or a dynamic set object). */
export function userRuleWriters(src: string, file: string): Array<{ file: string; fn: string; recomputes: boolean }> {
  const out: Array<{ file: string; fn: string; recomputes: boolean }> = [];
  for (const m of src.matchAll(/\.(insert|update)\((?:schema\.)?users\)/g)) {
    const after = src.slice(m.index!, m.index! + 600);
    if (m[1] === 'update') {
      const set = after.match(/\.set\(([\s\S]*?)\)\s*\.where/);
      const arg = set?.[1].trim() ?? '';
      const literal = arg.startsWith('{');
      if (literal && !/\b(role|isActive|approverId)\b/.test(arg)) continue; // e.g. password, TOTP, session version
    }
    const fn = enclosingFunction(src, m.index!);
    out.push({ file, fn: fn.name, recomputes: /recomputeSelfApproval\(/.test(fn.body) });
  }
  return out;
}

describe('static rules', () => {
  const EXEMPT = (rel: string) => rel.startsWith('scripts/') || rel === 'src/db/clear-tenant-data.ts';

  it('every function that writes users.role / is_active / approver_id calls recomputeSelfApproval (ruling Q5 exemptions: scripts, clearTenantData, tests)', () => {
    const writers = sourceFiles(path.join(ROOT, 'src'))
      .map((f) => ({ rel: path.relative(ROOT, f), src: readFileSync(f, 'utf8') }))
      .filter((f) => !EXEMPT(f.rel))
      .flatMap((f) => userRuleWriters(f.src, f.rel));
    expect(writers.filter((w) => !w.recomputes)).toEqual([]);
    // The inventory (so a writer can't silently disappear from the scan).
    expect(writers.map((w) => `${w.file}:${w.fn}`).sort()).toEqual(expect.arrayContaining([
      'src/lib/tenant/provision.ts:provisionTenant',
      'src/server/actions/import.ts:bulkImportEmployees',
      'src/server/actions/users.ts:createUser',
      'src/server/actions/users.ts:createUserWithPassword',
      'src/server/actions/users.ts:setUserApprover',
      'src/server/actions/users.ts:updateUser',
    ]));
  });

  it('fixture: a writer that changes role without recomputing is flagged; a password update is not', () => {
    const fixture = `export async function demote(id) { await db.update(users).set({ role: 'employee' }).where(eq(users.id, id)); }
      export async function setPassword(id) { await db.update(users).set({ passwordHash: 'x' }).where(eq(users.id, id)); }
      export async function addUser() { await tx.insert(users).values({}); await recomputeSelfApproval(tx, a, 'r'); }`;
    expect(userRuleWriters(fixture, 'f.ts')).toEqual([
      { file: 'f.ts', fn: 'demote', recomputes: false },
      { file: 'f.ts', fn: 'addUser', recomputes: true },
    ]);
  });

  it('no code formats the approver line except approval-label.ts ("Self-approved"/"Self-rejected" literals)', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src'))
      .map((f) => ({ rel: path.relative(ROOT, f), src: readFileSync(f, 'utf8') }))
      .filter((f) => f.rel !== 'src/server/internal/approval-label.ts')
      .flatMap((f) => [...stripComments(f.src).matchAll(/(['"`])Self-(approved|rejected)\1|>\s*Self-(approved|rejected)\s*</g)].map(() => f.rel));
    expect(offenders).toEqual([]);
  });

  it('the Approvals client sends the reviewed version (seen = submissionCount) and only once the review has loaded', () => {
    const client = readFileSync(path.join(ROOT, 'src/app/(app)/admin/approvals/ApprovalsClient.tsx'), 'utf8');
    expect(client.match(/seen: reviewData\.submissionCount/g)).toHaveLength(2);
    expect(client).toMatch(/if \(!reviewData\) return null;/);
  });

  it('getTimesheetForReview reads submission_count BEFORE the entries (safe ordering, see its doc comment)', () => {
    const src = readFileSync(path.join(ROOT, 'src/server/actions/timesheet.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function getTimesheetForReview'));
    expect(fn.indexOf('submissionCount: timesheetPeriods.submissionCount')).toBeLessThan(fn.indexOf('getTimesheetEntriesForEmployee('));
  });
});
