import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C3 / T-C3a: seedIndirectCodes adds the standard codes only to a workspace that has none,
 * and reports how many it created: any existing row → { created: 0 } with no insert; empty → the 9 defaults, inserted
 * with ON CONFLICT (code) DO NOTHING so a racing insert is skipped, never an error (T-C3d proves the race on Postgres).
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
import { indirectChargeCodes } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { seedIndirectCodes } from '@/server/actions/indirect-codes';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());

describe('seedIndirectCodes (C3)', () => {
  it('any existing row → { created: 0 } and no insert', async () => {
    db.onSelect(indirectChargeCodes, [{ id: 'existing-1' }]);
    expect(await seedIndirectCodes()).toEqual({ ok: true, data: { created: 0 } });
    expect(db.inserts).toHaveLength(0);
  });

  it('an empty workspace → the 9 defaults, created: 9', async () => {
    db.onSelect(indirectChargeCodes, []);
    db.onReturning('insert', indirectChargeCodes, Array.from({ length: 9 }, (_, i) => ({ id: `n${i}` })));
    expect(await seedIndirectCodes()).toEqual({ ok: true, data: { created: 9 } });
    expect(db.inserts).toHaveLength(1);
    expect((db.inserts[0].values as unknown as { code: string }[]).map((r) => r.code)).toEqual(['OH-001', 'GA-001', 'IRAD-001', 'BP-001', 'LV-AL', 'LV-SL', 'LV-HOL', 'LV-LWOP', 'UA-001']);
  });

  it('created counts what was actually inserted (a racing insert of one code → 8, not an error)', async () => {
    db.onSelect(indirectChargeCodes, []);
    db.onReturning('insert', indirectChargeCodes, Array.from({ length: 8 }, (_, i) => ({ id: `n${i}` })));
    expect(await seedIndirectCodes()).toEqual({ ok: true, data: { created: 8 } });
  });
});
