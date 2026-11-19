import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A3-D6 / A3-D9 (product owner's decision 4): the admin change log records workspace time-zone
 * changes and charge-code assignments and removals, with who and when.
 * - updateWorkspaceTimezone writes one row (old → new) in its transaction; the same value writes nothing at all;
 * - the Audit trail words the new pairs, and resolves the person and the charge code by name.
 * The assign / unassign writers are in assign-access-actions.test.ts.
 */

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
  const admin = async () => ({ id: 'admin-1', email: 'a@x', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});
vi.mock('@/server/internal/workspace-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/workspace-settings')>()),
  getWorkspaceTimezone: async () => 'America/New_York',
}));

import * as dbModule from '@/db';
import { adminChangeLog, chargeCodes, users, workspaceSettings } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { updateWorkspaceTimezone } from '@/server/actions/workspace-settings';
import { getAdminChanges } from '@/server/actions/audit';
import { describeAdminChange } from '@/lib/audit/admin-change-format';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());
const ZERO = '00000000-0000-0000-0000-000000000000';
const PAT = '00000000-0000-4000-8000-000000000001';
const CODE = '00000000-0000-4000-8000-000000000011';

describe('updateWorkspaceTimezone logs the change (A3-D6)', () => {
  it('a change writes the setting and ONE log row (who, old → new) through the transaction client', async () => {
    db.onSelect(workspaceSettings, [{ timezone: 'America/New_York' }]);
    expect(await updateWorkspaceTimezone('america/chicago')).toEqual({ ok: true, data: 'America/Chicago' });
    expect(db.inserts.map((i) => i.table === workspaceSettings ? 'settings' : i.table === adminChangeLog ? 'log' : '?')).toEqual(['settings', 'log']);
    expect(db.inserts.find((i) => i.table === adminChangeLog)!.values).toEqual({
      actorId: 'admin-1', entity: 'workspace_settings', entityId: ZERO, action: 'timezone_changed',
      oldValue: { timezone: 'America/New_York' }, newValue: { timezone: 'America/Chicago' },
    });
  });

  it('no settings row yet → old is null', async () => {
    expect(await updateWorkspaceTimezone('UTC')).toEqual({ ok: true, data: 'UTC' });
    expect(db.inserts.find((i) => i.table === adminChangeLog)!.values).toMatchObject({ oldValue: { timezone: null }, newValue: { timezone: 'UTC' } });
  });

  it('the same zone (after canonicalising) writes nothing and logs nothing', async () => {
    db.onSelect(workspaceSettings, [{ timezone: 'America/Chicago' }]);
    expect(await updateWorkspaceTimezone('america/chicago')).toEqual({ ok: true, data: 'America/Chicago' });
    expect(db.inserts).toEqual([]);
  });

  it('an invalid zone is refused before any read or write', async () => {
    expect(await updateWorkspaceTimezone('EST')).toMatchObject({ ok: false, code: 'validation' });
    expect(db.ops).toEqual([]);
  });
});

describe('the Audit trail words and names the new pairs (A3-D6, A3-D9)', () => {
  const names = { [PAT]: 'Pat Doe', [CODE]: 'NAV-0001' };
  const row = (entity: string, action: string, entityId: string, oldValue: unknown, newValue: unknown) => ({ entity, action, entityId, oldValue, newValue });

  it('describeAdminChange', () => {
    expect(describeAdminChange(row('workspace_settings', 'timezone_changed', ZERO, { timezone: 'America/New_York' }, { timezone: 'America/Chicago' }), names))
      .toEqual({ change: 'Time zone changed', details: 'Workspace · America/New_York → America/Chicago' });
    expect(describeAdminChange(row('workspace_settings', 'timezone_changed', ZERO, { timezone: null }, { timezone: 'UTC' }), names).details)
      .toBe('Workspace · Not set → UTC');
    expect(describeAdminChange(row('user_charge_code', 'assigned', PAT, null, { chargeCodeId: CODE }), names))
      .toEqual({ change: 'Charge code assigned', details: 'Pat Doe · NAV-0001' });
    expect(describeAdminChange(row('user_charge_code', 'removed', PAT, { chargeCodeId: CODE, isActive: true }, { chargeCodeId: CODE, isActive: false }), names))
      .toEqual({ change: 'Charge code removed', details: 'Pat Doe · NAV-0001' });
  });

  it('getAdminChanges resolves the person (entity_id) and the charge code (inside the values) by name', async () => {
    const logRow = { id: 'l1', createdAt: new Date('2026-11-19T15:00:00Z'), entity: 'user_charge_code', action: 'assigned', entityId: PAT, oldValue: null, newValue: { chargeCodeId: CODE }, byName: 'Ann' };
    db.onSelect(adminChangeLog, [{ total: 1 }]);
    db.onSelect(adminChangeLog, [logRow]);
    db.onSelect(users, [{ id: PAT, name: 'Pat Doe' }]);
    db.onSelect(chargeCodes, [{ id: CODE, name: 'NAV-0001' }]);
    const page = await getAdminChanges({ start: '2026-11-01' as never, end: '2026-11-30' as never });
    expect(page.rows).toEqual([{ id: 'l1', createdAt: logRow.createdAt, byName: 'Ann', change: 'Charge code assigned', details: 'Pat Doe · NAV-0001' }]);
  });
});
