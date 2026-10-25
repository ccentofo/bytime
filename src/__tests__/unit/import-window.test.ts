import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * feature-plan-certified-outputs.md C1 / §9 "Window": the open/closed rule (clock injected), the app-only filter on
 * submitted events (imported submitted events don't close it), the fail-closed control-plane read, the submit-time
 * close (predicate `IS NULL`, no row lock on later submits), and the §3 lock order in submitPeriod and both import
 * actions (static). The DB behaviour itself is in integration/migration-import.test.ts.
 */

const h = vi.hoisted(() => ({ cpFails: false, reopen: null as Date | null, wheres: [] as unknown[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane', () => ({
  controlDb: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (h.cpFails) throw new Error('control plane down');
            return [{ until: h.reopen }];
          },
        }),
      }),
    }),
  },
}));

import {
  isImportWindowOpen, readImportWindowFacts, readImportWindowReopen, closeImportWindowOnSubmit,
} from '@/server/internal/import-window';
import { UserFacingError } from '@/lib/errors';

const ROOT = path.resolve(__dirname, '../../..');
const T = new Date('2026-10-25T12:00:00Z');
const facts = (o: Partial<Parameters<typeof isImportWindowOpen>[0]> = {}) => ({
  settingsRowExists: true, historyImportClosedAt: null, hasAppSubmittedEvent: false, reopenUntil: null, ...o,
});

beforeEach(() => { h.cpFails = false; h.reopen = null; h.wheres = []; });

describe('isImportWindowOpen', () => {
  it('open before any submission', () => {
    expect(isImportWindowOpen(facts(), T)).toBe(true);
  });

  it('closed once the first submission set history_import_closed_at', () => {
    expect(isImportWindowOpen(facts({ historyImportClosedAt: new Date('2026-10-01') }), T)).toBe(false);
  });

  it('old code: an app-sourced submitted event without the flag → closed', () => {
    expect(isImportWindowOpen(facts({ hasAppSubmittedEvent: true }), T)).toBe(false);
  });

  it('a missing workspace_settings row → closed', () => {
    expect(isImportWindowOpen(facts({ settingsRowExists: false }), T)).toBe(false);
  });

  it('founder reopen: open until T (clock injected), closed at and after T', () => {
    const closed = facts({ historyImportClosedAt: new Date('2026-10-01'), hasAppSubmittedEvent: true });
    const until = new Date(T.getTime() + 60_000);
    expect(isImportWindowOpen({ ...closed, reopenUntil: until }, T)).toBe(true);
    expect(isImportWindowOpen({ ...closed, reopenUntil: until }, until)).toBe(false);
    expect(isImportWindowOpen({ ...closed, reopenUntil: until }, new Date(until.getTime() + 1))).toBe(false);
  });
});

describe('reading the facts', () => {
  function fakeTx(settings: Array<{ closedAt: Date | null }>, submitted: Array<{ id: string }>) {
    const results = [settings, submitted];
    return {
      select: () => ({
        from: () => ({
          where: (w: unknown) => {
            h.wheres.push(w);
            return { limit: async () => results.shift() ?? [] };
          },
        }),
      }),
    };
  }

  it('only APP-sourced submitted events count (imported submitted events never close the window)', async () => {
    const f = await readImportWindowFacts(fakeTx([{ closedAt: null }], []) as never, 'tenant-1');
    expect(f).toEqual({ settingsRowExists: true, historyImportClosedAt: null, hasAppSubmittedEvent: false, reopenUntil: null });
    const eventsWhere = new PgDialect().sqlToQuery(h.wheres[1] as SQL);
    expect(eventsWhere.sql).toContain('"period_events"."event" = $1');
    expect(eventsWhere.sql).toContain('"period_events"."source" = $2');
    expect(eventsWhere.params).toEqual(['submitted', 'app']);
  });

  it('control-plane read failure → the batch is refused (UserFacingError), never treated as open', async () => {
    h.cpFails = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(readImportWindowReopen('tenant-1')).rejects.toBeInstanceOf(UserFacingError);
    await expect(readImportWindowFacts(fakeTx([{ closedAt: null }], []) as never, 'tenant-1')).rejects.toThrow(/Nothing was imported/);
  });

  it('the reopen expiry is read fresh from the control plane', async () => {
    h.reopen = new Date('2026-11-01T00:00:00Z');
    expect(await readImportWindowReopen('tenant-1')).toEqual(h.reopen);
  });
});

describe('closing on the first submission', () => {
  it('UPDATE … SET history_import_closed_at WHERE id = 1 AND history_import_closed_at IS NULL (a no-op once closed)', async () => {
    let set: Record<string, unknown> = {};
    let where: unknown;
    const tx = { update: () => ({ set: (s: Record<string, unknown>) => { set = s; return { where: async (w: unknown) => { where = w; } }; } }) };
    await closeImportWindowOnSubmit(tx as never);
    expect(Object.keys(set)).toEqual(['historyImportClosedAt']);
    expect(set.historyImportClosedAt).toBeInstanceOf(Date);
    const q = new PgDialect().sqlToQuery(where as SQL);
    expect(q.sql).toBe('("workspace_settings"."id" = $1 and "workspace_settings"."history_import_closed_at" IS NULL)');
  });
});

describe('§3 lock order (static)', () => {
  const src = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

  it('submitPeriod: the SHARED window lock is the first statement of its transaction, before lockEmployeeTimesheet; it closes the window in the same transaction', () => {
    const periods = src('src/server/actions/periods.ts');
    const body = periods.slice(periods.indexOf('export async function submitPeriod'), periods.indexOf('/** Email the employee about the approval'));
    const tx = body.slice(body.indexOf('db.transaction(async (tx) => {'));
    const firstAwait = tx.match(/await\s+([A-Za-z]+)\(/)?.[1];
    expect(firstAwait).toBe('lockImportWindowShared');
    expect(tx.indexOf('lockImportWindowShared(tx)')).toBeLessThan(tx.indexOf('lockEmployeeTimesheet(tx, userId)'));
    expect(tx.indexOf('closeImportWindowOnSubmit(tx)')).toBeGreaterThan(tx.indexOf("event: 'submitted'"));
  });

  it('both import actions: EXCLUSIVE window lock → window re-checked → per-employee locks (sorted)', () => {
    const migration = src('src/server/actions/migration.ts');
    for (const fn of ['export async function importMigrationData', 'export async function importMigrationPeriods']) {
      const start = migration.indexOf(fn);
      const end = migration.indexOf('export async function', start + fn.length);
      const body = migration.slice(start, end === -1 ? undefined : end);
      const lock = body.indexOf('await lockImportWindowExclusive(tx)');
      const check = body.indexOf('await assertImportWindowOpen(tx');
      const employees = body.indexOf('await lockEmployees(tx');
      expect(lock, fn).toBeGreaterThan(-1);
      expect(lock, fn).toBeLessThan(check);
      expect(check, fn).toBeLessThan(employees);
    }
    expect(migration).toMatch(/const sorted = \[\.\.\.new Set\(userIds\)\]\.sort\(\);\s*for \(const id of sorted\) await lockEmployeeTimesheet\(tx, id\);/);
  });
});
