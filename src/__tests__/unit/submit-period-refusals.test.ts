import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A3-G4: submitPeriod refuses (1) before the period's last WEEKDAY, naming that date, by the
 * workspace's today; and (2) an empty timesheet. In both cases nothing is written. Fake database (fake-control-db);
 * the period (Oct 16–31, 2026, semimonthly) ends on a Saturday, so its last weekday is Friday Oct 30.
 */

const h = vi.hoisted(() => ({ today: '2026-10-29' }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
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
  const employee = async () => ({ id: 'emp-1', email: 'e@x', fullName: 'Pat', role: 'employee' });
  return { AuthorizationError, requireSession: employee, requireApprover: employee, requireApproverFresh: employee, requireAdmin: employee, getEmployeeScope: async () => [] };
});
vi.mock('@/server/internal/periods', async (importOriginal) => {
  const { DEFAULT_PERIOD_CONFIG } = await import('@/lib/date-utils');
  return {
    ...(await importOriginal<typeof import('@/server/internal/periods')>()),
    resolvePeriod: async () => ({ config: DEFAULT_PERIOD_CONFIG, numDays: 16 }),
    lockEmployeeTimesheet: async () => {},
  };
});
vi.mock('@/server/internal/import-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/import-window')>()),
  lockImportWindowShared: async () => {},
  closeImportWindowOnSubmit: async () => {},
}));
vi.mock('@/server/internal/workspace-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/workspace-settings')>()),
  getWorkspaceToday: async () => h.today,
  getWorkspaceTimezone: async () => 'America/New_York',
}));

import * as dbModule from '@/db';
import { timesheetEntries } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { submitPeriod } from '@/server/actions/periods';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());
const submit = () => submitPeriod({ expectedUserId: 'emp-1', periodStart: '2026-10-16' as never });

describe('submitPeriod refusals (A3-G4)', () => {
  it('before the last weekday (Thu Oct 29): refused with the date, before any read or write', async () => {
    h.today = '2026-10-29';
    expect(await submit()).toEqual({ ok: false, code: 'validation', error: 'Cannot submit before the last day of the pay period (Oct 30, 2026).' });
    expect(db.ops).toEqual([]);
  });

  it('an empty timesheet on the last weekday: refused, and nothing written', async () => {
    h.today = '2026-10-30';
    db.onSelect(timesheetEntries, [{ count: 0 }]);
    expect(await submit()).toEqual({ ok: false, code: 'validation', error: 'Cannot submit an empty timesheet. Please enter your hours before submitting.' });
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });
});
