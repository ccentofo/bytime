import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * UX-4C1-AUDIT.md M3 — getLaborCategoryAssignmentsWithOverlaps: admin only; returns the assignments AND the ids of
 * every assignment in an overlap pair (findOverlaps over the assignment rows), which the Labor categories tab refetches
 * after Assign or End….
 */

const s = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({
  requireAdmin: async () => { if (s.role !== 'admin') throw new Error('forbidden'); return { id: 'a', role: 'admin' }; },
  requireAdminFresh: async () => ({ id: 'a', role: 'admin' }),
}));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, __db: db };
});

import * as dbModule from '@/db';
import { userLaborCategories } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { getLaborCategoryAssignmentsWithOverlaps } from '@/server/actions/labor-categories';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => { db.reset(); s.role = 'admin'; });

const row = (assignmentId: string, lcId: string, effectiveDate: string, endDate: string | null) => ({
  assignmentId, userId: 'u1', employeeName: 'Pat Doe', effectiveDate, endDate, lcId, lcatCode: lcId, title: lcId,
  clinId: 'clin-1', clinNumber: '0001', slinId: null, slinNumber: null, contractId: 'k1',
});

describe('getLaborCategoryAssignmentsWithOverlaps (M3)', () => {
  it('the assignments plus both ids of each overlapping pair; nothing else', async () => {
    const assignments = [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }];
    db.onSelect(userLaborCategories, assignments);                                          // the list
    db.onSelect(userLaborCategories, [                                                     // the overlap rows
      row('x1', 'L1', '2026-01-01', null), row('x2', 'L2', '2026-06-01', null), row('x3', 'L1', '2025-01-01', '2025-12-31'),
    ]);
    const out = await getLaborCategoryAssignmentsWithOverlaps();
    expect(out.assignments).toEqual(assignments);
    expect([...out.overlapIds].sort()).toEqual(['x1', 'x2']);
  });

  it('refuses a non-admin before any read', async () => {
    s.role = 'supervisor';
    await expect(getLaborCategoryAssignmentsWithOverlaps()).rejects.toThrow('forbidden');
    expect(db.ops).toEqual([]);
  });
});
