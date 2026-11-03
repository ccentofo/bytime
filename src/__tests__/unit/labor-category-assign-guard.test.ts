import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C4 (R4), unit companion to integration/labor-categories.test.ts (T-C4b), runnable without
 * Postgres: assignUserToLaborCategory validates the id after the guard, refuses an unknown category ("no longer
 * exists") and one that is inactive or sits on an inactive CLIN or contract, and writes nothing then.
 */

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'admin-1', email: 'a@x', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import * as dbModule from '@/db';
import { laborCategories, userLaborCategories } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { assignUserToLaborCategory } from '@/server/actions/labor-categories';
import type { CalendarDate } from '@/lib/calendar-date';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());
const LC = '11111111-1111-4111-8111-111111111111';
const assign = (laborCategoryId = LC) => assignUserToLaborCategory({ userId: '22222222-2222-4222-8222-222222222222', laborCategoryId, effectiveDate: '2026-11-01' as CalendarDate });
const inactive = "This labor category can't be assigned because it, its CLIN or its contract is inactive.";

describe('assignUserToLaborCategory (C4)', () => {
  it('a non-UUID id → a validation error, nothing written', async () => {
    expect(await assign('nope')).toEqual({ ok: false, code: 'validation', error: 'Labor category is not a valid identifier.' });
    expect(db.inserts).toHaveLength(0);
  });

  it('L4: a non-UUID employee id → a validation error, nothing read or written', async () => {
    db.onSelect(laborCategories, [{ lcatStatus: 'active', clinStatus: 'active', contractStatus: 'active' }]);
    const r = await assignUserToLaborCategory({ userId: 'not-a-uuid', laborCategoryId: LC, effectiveDate: '2026-11-01' as CalendarDate });
    expect(r).toEqual({ ok: false, code: 'validation', error: 'Employee is not a valid identifier.' });
    expect(db.inserts).toHaveLength(0);
  });

  it('an unknown id → "That labor category no longer exists."', async () => {
    db.onSelect(laborCategories, []);
    expect(await assign()).toEqual({ ok: false, code: 'validation', error: 'That labor category no longer exists.' });
    expect(db.inserts).toHaveLength(0);
  });

  it.each([
    ['the category', { lcatStatus: 'inactive', clinStatus: 'active', contractStatus: 'active' }],
    ['its CLIN', { lcatStatus: 'active', clinStatus: 'inactive', contractStatus: 'active' }],
    ['its contract', { lcatStatus: 'active', clinStatus: 'active', contractStatus: 'closed' }],
  ])('%s inactive → refused, nothing written', async (_what, row) => {
    db.onSelect(laborCategories, [row]);
    expect(await assign()).toEqual({ ok: false, code: 'validation', error: inactive });
    expect(db.inserts).toHaveLength(0);
  });

  it('an assignable category → assigned', async () => {
    db.onSelect(laborCategories, [{ lcatStatus: 'active', clinStatus: 'active', contractStatus: 'active' }]);
    db.onReturning('insert', userLaborCategories, [{ id: 'a1' }]);
    expect(await assign()).toEqual({ ok: true, data: { id: 'a1' } });
    expect(db.inserts).toHaveLength(1);
  });
});
