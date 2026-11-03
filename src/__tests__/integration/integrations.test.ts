import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-ux-page-fixes.md C13 / T-C13b: saveMapping is one atomic upsert on mapping_unique_idx that returns the
 * row's id — the same id when it updates; deleteMapping validates the id, deletes, and says "That mapping no longer
 * exists." when nothing was deleted.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
const h = vi.hoisted(() => ({ adminId: '' }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const admin = async () => ({ id: h.adminId, email: 'admin@x', fullName: 'Admin', role: 'admin' });
  return { ...actual, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import { saveMapping, deleteMapping } from '@/server/actions/integrations';

describe('integration mappings (C13, T-C13b)', () => {
  let connectionId: string;
  const base = () => ({ connectionId, entityType: 'employee', bytimeEntityId: '11111111-1111-4111-8111-111111111111', bytimeEntityName: 'Ann' });

  beforeEach(async () => {
    await cleanupTestData();
    h.adminId = (await createTestUser({ role: 'admin' })).id;
    const [c] = await getTestDb().insert(schema.integrationConnections).values({ provider: 'quickbooks_online', displayName: 'QuickBooks — Acme', connectedBy: h.adminId }).returning();
    connectionId = c.id;
  });
  afterEach(async () => { await cleanupTestData(); });

  it('saveMapping returns the id on insert, and the same id when it updates the same row', async () => {
    const first = await expectOk(saveMapping({ ...base(), externalEntityId: 'q1', externalEntityName: 'Ann QBO' }));
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    const second = await expectOk(saveMapping({ ...base(), bytimeEntityName: 'Ann B', externalEntityId: 'q2', externalEntityName: 'Ann (new)' }));
    expect(second.id).toBe(first.id);
    const rows = await getTestDb().select().from(schema.integrationEntityMappings).where(eq(schema.integrationEntityMappings.connectionId, connectionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalEntityId: 'q2', externalEntityName: 'Ann (new)', bytimeEntityName: 'Ann B' });
  });

  it('two concurrent saves of the same row don\'t race into a unique violation', async () => {
    const [a, b] = await Promise.all([
      saveMapping({ ...base(), externalEntityId: 'q1', externalEntityName: 'One' }),
      saveMapping({ ...base(), externalEntityId: 'q2', externalEntityName: 'Two' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await getTestDb().select().from(schema.integrationEntityMappings)).toHaveLength(1);
  });

  it('deleteMapping removes it; a second delete → "That mapping no longer exists."; a non-UUID → validation', async () => {
    const { id } = await expectOk(saveMapping({ ...base(), externalEntityId: 'q1', externalEntityName: 'Ann QBO' }));
    await expectOk(deleteMapping(id));
    expect(await getTestDb().select().from(schema.integrationEntityMappings)).toHaveLength(0);
    await expectFailure(deleteMapping(id), 'validation', /^That mapping no longer exists\.$/);
    await expectFailure(deleteMapping('temp-123'), 'validation', /Mapping is not a valid identifier/);
  });
});
