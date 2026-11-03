import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTestDb, cleanupTestData, createTestContract, createTestClin, expectOk, expectFailure } from './helpers';
import { seedContractsC1Fixture, C1_EXPECTED } from './contracts-c1-fixture';

/**
 * feature-plan-ux-kit-contracts.md §10 C-1 and C-5, against real Postgres.
 * C-1: getContractsOverview on the C-1 fixture returns the LITERAL figures recorded from the old getContractSummaries
 * (contracts-c1-fixture.ts C1_EXPECTED, confirmed by the recorder before that function was removed): per contract,
 * CLIN and SLIN; SLIN money is part of its CLIN's, never added on top; the indirect entry counts nowhere; totals are
 * active-only except unpricedHoursAll, which equals Home's figure.
 * C-5: server hardening — invalid status/type; unknown ids → not_found; the saved row is returned; a closed contract
 * takes no CLIN; a CLIN under a closed contract takes no SLIN; non-UUID parents → validation.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const admin = async () => ({ id: '00000000-0000-4000-8000-0000000000c1', email: 'admin@x', fullName: 'Admin', role: 'admin' });
  return { ...actual, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import { getContractsOverview, updateContract } from '@/server/actions/contracts';
import { createClin, updateClin } from '@/server/actions/clins';
import { createSlin, updateSlin } from '@/server/actions/slins';
import { contractBurnSummary } from '@/server/internal/dashboard';

const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const money = (n: { hours: number; pricedCost: number; unpricedHours: number }) => ({ hours: n.hours, pricedCost: n.pricedCost, unpricedHours: n.unpricedHours });

describe('getContractsOverview (C-1)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('returns the recorded literal figures per contract, CLIN and SLIN', async () => {
    await seedContractsC1Fixture();
    const overview = await getContractsOverview();
    expect(Object.fromEntries(overview.contracts.map((c) => [c.name, money(c)]))).toEqual(C1_EXPECTED.contracts);
    expect(Object.fromEntries(overview.contracts.flatMap((c) => c.clins.map((cl) => [`${c.name}/${cl.clinNumber}`, money(cl)])))).toEqual(C1_EXPECTED.clins);
    expect(Object.fromEntries(overview.contracts.flatMap((c) => c.clins.flatMap((cl) => cl.slins.map((s) => [`${c.name}/${cl.clinNumber}/${s.slinNumber}`, money(s)]))))).toEqual(C1_EXPECTED.slins);
  });

  it('SLIN money is part of its CLIN (never added on top); the indirect entry counts nowhere', async () => {
    await seedContractsC1Fixture();
    const alpha = (await getContractsOverview()).contracts.find((c) => c.name === 'Alpha Support')!;
    const clin = alpha.clins.find((c) => c.clinNumber === '0001')!;
    expect(clin.pricedCost).toBe(2558.44);                                  // not 2558.44 + 933.44
    expect(clin.hours).toBe(25.75);                                         // includes the SLIN's 6.25 once
    const all = (await getContractsOverview()).contracts.reduce((s, c) => s + c.hours, 0);
    expect(Math.round(all * 100) / 100).toBe(36.25);                        // 32.75 + 3.50 + 0; the 8.00 indirect hours aren't here
  });

  it('totals: active contracts only, except unpricedHoursAll, which equals Home\'s figure', async () => {
    await seedContractsC1Fixture();
    const overview = await getContractsOverview();
    expect(overview.totals).toEqual(C1_EXPECTED.totals);
    const home = await contractBurnSummary(getTestDb());
    expect(overview.totals.unpricedHoursAll).toBe(Math.round(home.reduce((s, c) => s + c.unpricedHours, 0) * 100) / 100);
  });
});

describe('contract / CLIN / SLIN hardening (C-5)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('updateContract: invalid status / type; unknown id → not_found; non-UUID → validation; returns the saved row', async () => {
    const c = await createTestContract();
    await expectFailure(updateContract(c.id, { status: 'archived' as never }), 'validation', /^Invalid contract status\.$/);
    await expectFailure(updateContract(c.id, { contractType: 'joint' }), 'validation', /^Invalid contract type\.$/);
    await expectFailure(updateContract(UNKNOWN, { name: 'X' }), 'not_found', /^That contract no longer exists\.$/);
    await expectFailure(updateContract('nope', { name: 'X' }), 'validation');
    expect(await expectOk(updateContract(c.id, { status: 'closed', fundedValue: '1234.50' }))).toMatchObject({ id: c.id, status: 'closed', fundedValue: '1234.50' });
  });

  it('createClin: refused on a closed contract; unknown → not_found; non-UUID → validation; returns the row', async () => {
    const closed = await createTestContract({ status: 'closed' });
    await expectFailure(createClin({ contractId: closed.id, clinNumber: '0001' }), 'validation', /^This contract isn't active\. Reopen it before adding CLINs\.$/);
    await expectFailure(createClin({ contractId: UNKNOWN, clinNumber: '0001' }), 'not_found');
    await expectFailure(createClin({ contractId: 'nope', clinNumber: '0001' }), 'validation');
    const active = await createTestContract();
    expect(await expectOk(createClin({ contractId: active.id, clinNumber: '0001', fundedAmount: '500.00' }))).toMatchObject({ contractId: active.id, clinNumber: '0001', fundedAmount: '500.00' });
  });

  it('createSlin: refused when the CLIN or its contract is inactive; unknown / non-UUID; updateClin / updateSlin unknown → not_found', async () => {
    const closed = await createTestContract({ status: 'closed' });
    const clinOfClosed = await createTestClin(closed.id);
    await expectFailure(createSlin({ clinId: clinOfClosed.id, slinNumber: 'AA' }), 'validation', /^This CLIN or its contract isn't active\.$/);
    const active = await createTestContract();
    const inactiveClin = await createTestClin(active.id, { status: 'inactive' });
    await expectFailure(createSlin({ clinId: inactiveClin.id, slinNumber: 'AA' }), 'validation', /^This CLIN or its contract isn't active\.$/);
    await expectFailure(createSlin({ clinId: UNKNOWN, slinNumber: 'AA' }), 'not_found');
    await expectFailure(createSlin({ clinId: 'nope', slinNumber: 'AA' }), 'validation');
    const clin = await createTestClin(active.id);
    const slin = await expectOk(createSlin({ clinId: clin.id, slinNumber: 'AA' }));
    expect(await expectOk(updateSlin(slin.id, { fundedAmount: '20.00' }))).toMatchObject({ id: slin.id, fundedAmount: '20.00' });
    await expectFailure(updateClin(UNKNOWN, { description: 'x' }), 'not_found', /^That CLIN no longer exists\.$/);
    await expectFailure(updateSlin(UNKNOWN, { description: 'x' }), 'not_found', /^That SLIN no longer exists\.$/);
    await expectFailure(updateClin('nope', { description: 'x' }), 'validation');
  });
});
