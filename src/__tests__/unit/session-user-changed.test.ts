import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * UX-TIMESHEET-B-AUDIT H3 (server, unit): saveTimesheetBatch and submitPeriod compare the required `expectedUserId` with
 * the session user right after requireSession() — a mismatch is refused with SESSION_USER_CHANGED before the database is
 * touched at all (no read, no write); a match goes on to the database. The integration suite
 * (integration/session-user-changed.test.ts) proves no rows are written against a real database.
 */

const h = vi.hoisted(() => ({ dbTouched: [] as string[], sessionId: 'sarah-id' }));
vi.mock('server-only', () => ({}));
vi.mock('@/db', () => {
  const touch = (name: string) => { h.dbTouched.push(name); throw new Error(`database reached (${name})`); };
  return { getDb: async () => touch('getDb'), getDbForWrite: async () => touch('getDbForWrite'), getDbForAuth: async () => touch('getDbForAuth'), getDbForUrl: () => touch('getDbForUrl') };
});
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  return { ...actual, requireSession: async () => ({ id: h.sessionId, email: 's@x', fullName: 'Sarah', role: 'supervisor' }) };
});
vi.mock('@/server/internal/workspace-settings', () => ({
  getWorkspaceToday: async () => { h.dbTouched.push('getWorkspaceToday'); throw new Error('database reached (getWorkspaceToday)'); },
  getWorkspaceTimezone: async () => 'UTC',
}));

import { saveTimesheetBatch } from '@/server/actions/timesheet';
import { submitPeriod } from '@/server/actions/periods';
import { SESSION_USER_CHANGED } from '@/lib/timesheet/copy';
import type { CalendarDate } from '@/lib/calendar-date';

const START = '2026-10-01' as CalendarDate;
const batch = (expectedUserId: string) => ({ expectedUserId, periodStart: START, cells: [{ chargeCodeId: 'c', dayIndex: 1, hours: 4, isEdit: false, isLateEntry: false }] });

beforeEach(() => { h.dbTouched.length = 0; h.sessionId = 'sarah-id'; });

describe('expectedUserId is checked first (H3)', () => {
  it('the constant is the ruled wording', () => {
    expect(SESSION_USER_CHANGED).toBe("You're signed in as a different person now. Reload this page to continue.");
  });

  it("saveTimesheetBatch with Jane's id under Sarah's session → SESSION_USER_CHANGED, and the database is never touched", async () => {
    expect(await saveTimesheetBatch(batch('jane-id'))).toEqual({ ok: false, code: 'validation', error: SESSION_USER_CHANGED });
    expect(h.dbTouched).toEqual([]);
  });

  it("submitPeriod with Jane's id under Sarah's session → SESSION_USER_CHANGED, and the database is never touched", async () => {
    expect(await submitPeriod({ expectedUserId: 'jane-id', periodStart: START })).toEqual({ ok: false, code: 'validation', error: SESSION_USER_CHANGED });
    expect(h.dbTouched).toEqual([]);
  });

  it('a matching id passes the check and goes on to the database', async () => {
    await expect(saveTimesheetBatch(batch('sarah-id'))).rejects.toThrow(/database reached/);
    await expect(submitPeriod({ expectedUserId: 'sarah-id', periodStart: START })).rejects.toThrow(/database reached/);
    expect(h.dbTouched.length).toBeGreaterThan(0);
  });

  it('a missing expectedUserId (a stale client) is refused too', async () => {
    const stale = { periodStart: START, cells: [] } as unknown as Parameters<typeof saveTimesheetBatch>[0];
    expect(await saveTimesheetBatch(stale)).toEqual({ ok: false, code: 'validation', error: SESSION_USER_CHANGED });
    expect(h.dbTouched).toEqual([]);
  });
});
