import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C13, unit companion to integration/integrations.test.ts (T-C13b), runnable without
 * Postgres: saveMapping is one insert … ON CONFLICT (connection, entity type, CadenzPoint id) DO UPDATE … RETURNING id
 * (no select-then-write) and returns { id }; deleteMapping validates the id first, and a delete that removes nothing
 * says "That mapping no longer exists.".
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
import { integrationEntityMappings } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { saveMapping, deleteMapping } from '@/server/actions/integrations';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());
const ID = '22222222-2222-4222-8222-222222222222';
const input = { connectionId: 'c1', entityType: 'employee', bytimeEntityId: 'u1', bytimeEntityName: 'Ann', externalEntityId: 'q1', externalEntityName: 'Ann QBO', metadata: '{}' };

describe('saveMapping / deleteMapping (C13)', () => {
  it('saveMapping: one upsert on the unique index, updating every field, returning { id }; no select first', async () => {
    db.onReturning('insert', integrationEntityMappings, [{ id: ID }]);
    expect(await saveMapping(input)).toEqual({ ok: true, data: { id: ID } });
    expect(db.ops).toEqual(['insert']);
    expect(db.inserts[0].values).toMatchObject(input);
    const conflict = db.conflicts[0] as { target: unknown[]; set: Record<string, unknown> };
    expect(conflict.target).toEqual([integrationEntityMappings.connectionId, integrationEntityMappings.entityType, integrationEntityMappings.bytimeEntityId]);
    expect(Object.keys(conflict.set).sort()).toEqual(['bytimeEntityName', 'externalEntityId', 'externalEntityName', 'metadata', 'updatedAt']);
    expect(conflict.set).toMatchObject({ externalEntityId: 'q1', externalEntityName: 'Ann QBO', bytimeEntityName: 'Ann', metadata: '{}' });
  });

  it('deleteMapping: a non-UUID → validation before any write', async () => {
    expect(await deleteMapping('temp-1730000000000')).toEqual({ ok: false, code: 'validation', error: 'Mapping is not a valid identifier.' });
    expect(db.ops).toEqual([]);
  });

  it('deleteMapping: nothing deleted → "That mapping no longer exists."; a deleted row → ok', async () => {
    expect(await deleteMapping(ID)).toEqual({ ok: false, code: 'validation', error: 'That mapping no longer exists.' });
    db.onReturning('delete', integrationEntityMappings, [{ id: ID }]);
    expect(await deleteMapping(ID)).toEqual({ ok: true, data: undefined });
  });
});
