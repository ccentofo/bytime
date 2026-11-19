import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * SWEEP-FINDINGS.md A3-D2: the QuickBooks charge-code and class imports validate every item (the charge codes with
 * createChargeCode's rules: an active CLIN on an active contract, lengths, the work location, UUIDs) and run in ONE
 * transaction, so a refused item or a duplicate halfway through writes nothing at all. A refused item's message names it
 * (lead, Q1). No QuickBooks call is made: the imports only write local rows.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
const sessionState = vi.hoisted(() => ({ user: null as null | { id: string; email: string; fullName: string; role: string } }));
vi.mock('@/auth', () => ({
  auth: async () => (sessionState.user ? { user: { ...sessionState.user, tenantSlug: 'test-tenant' } } : null),
}));

import { importQboChargeCodes, importQboClasses } from '@/server/actions/qbo';

describe('QuickBooks imports: validated, all or nothing (A3-D2)', () => {
  let connectionId: string;
  let activeClin: string;

  beforeEach(async () => {
    await cleanupTestData();
    const admin = await createTestUser({ role: 'admin' });
    sessionState.user = { id: admin.id, email: admin.email, fullName: admin.fullName, role: 'admin' };
    const [conn] = await getTestDb().insert(schema.integrationConnections).values({
      provider: 'quickbooks_online', displayName: 'QuickBooks — Test', connectedBy: admin.id,
    }).returning();
    connectionId = conn.id;
    activeClin = (await createTestClin((await createTestContract()).id)).id;
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  const counts = async () => ({
    codes: (await getTestDb().select().from(schema.chargeCodes)).length,
    classes: (await getTestDb().select().from(schema.costClasses)).length,
    mappings: (await getTestDb().select().from(schema.integrationEntityMappings)).length,
  });

  it('a valid import creates every code and mapping', async () => {
    const r = await expectOk(importQboChargeCodes(connectionId, [
      { qboId: '1', name: 'Senior Engineer', clinId: activeClin, workLocation: 'onsite' },
      { qboId: '2', name: 'Analyst', clinId: activeClin },
    ]));
    expect(r).toEqual({ created: 2, updated: 0 });
    expect(await counts()).toEqual({ codes: 2, classes: 0, mappings: 2 });
  });

  it("a closed contract's CLIN is refused, naming the item, and nothing is written (even the valid item before it)", async () => {
    const closedClin = (await createTestClin((await createTestContract({ status: 'closed' })).id)).id;
    const err = await expectFailure(importQboChargeCodes(connectionId, [
      { qboId: '1', name: 'Senior Engineer', clinId: activeClin },
      { qboId: '2', name: 'Old Work', clinId: closedClin },
    ]), 'validation');
    expect(err).toBe('"Old Work": Choose an active CLIN.');
    expect(await counts()).toEqual({ codes: 0, classes: 0, mappings: 0 });
  });

  it('a duplicate code as the 2nd of 3 items rolls back the 1st (no charge code, no mapping)', async () => {
    const r = await importQboChargeCodes(connectionId, [
      { qboId: '1', name: 'Alpha', clinId: activeClin },
      { qboId: '2', name: 'Alpha', clinId: activeClin }, // same name → same code
      { qboId: '3', name: 'Gamma', clinId: activeClin },
    ]);
    expect(r.ok).toBe(false);
    expect(await counts()).toEqual({ codes: 0, classes: 0, mappings: 0 });
  });

  it.each([
    ['a bad work location', { workLocation: 'moon' }, '"Bad": Location must be Onsite, Telework or Other.'],
    ['a name too long for a code', { name: 'x'.repeat(101) }, `"${'x'.repeat(101)}": The code must be 100 characters or fewer.`],
    ['a malformed CLIN id', { clinId: 'not-a-uuid' }, '"Bad": CLIN is not a valid identifier.'],
    ['a malformed class id', { classId: 'nope' }, '"Bad": Class is not a valid identifier.'],
  ])('%s is refused after a valid item, and nothing is written', async (_label, override, message) => {
    const err = await expectFailure(importQboChargeCodes(connectionId, [
      { qboId: '1', name: 'Good', clinId: activeClin },
      { qboId: '2', name: 'Bad', clinId: activeClin, ...override } as never,
    ]), 'validation');
    expect(err).toBe(message);
    expect(await counts()).toEqual({ codes: 0, classes: 0, mappings: 0 });
  });

  it('a malformed connection id is refused before any write', async () => {
    expect(await expectFailure(importQboChargeCodes('nope', [{ qboId: '1', name: 'Good', clinId: activeClin }]), 'validation')).toBe('Connection is not a valid identifier.');
    expect(await expectFailure(importQboClasses('nope', [{ qboId: '1', name: 'Gov' }]), 'validation')).toBe('Connection is not a valid identifier.');
    expect(await counts()).toEqual({ codes: 0, classes: 0, mappings: 0 });
  });

  it('classes: an empty name is refused after a valid class, and the valid class is rolled back', async () => {
    const err = await expectFailure(importQboClasses(connectionId, [
      { qboId: 'c1', name: 'Government' },
      { qboId: 'c2', name: '   ' },
    ]), 'validation');
    expect(err).toBe('"An item": Enter a name.');
    expect(await counts()).toEqual({ codes: 0, classes: 0, mappings: 0 });
  });

  it('classes: a valid import creates the classes and mappings', async () => {
    expect(await expectOk(importQboClasses(connectionId, [{ qboId: 'c1', name: 'Government' }, { qboId: 'c2', name: 'Commercial' }])))
      .toEqual({ created: 2, updated: 0 });
    expect(await counts()).toEqual({ codes: 0, classes: 2, mappings: 2 });
  });
});
