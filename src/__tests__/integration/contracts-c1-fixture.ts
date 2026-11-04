import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode } from './helpers';

/**
 * feature-plan-ux-kit-contracts.md §10 C-1: one fixture, used first by the recorder (contracts-c1-recorder.test.ts,
 * against the old getContractSummaries) and then by the C-1 test (against getContractsOverview). Every figure follows
 * from the cost-basis rules:
 *
 * Alpha Support (active, prime; funded 100,000.00, ceiling 150,000.00; 2026-01-01 → 2026-12-31)
 *   CLIN 0001 "Base year" (funded 60,000.00)
 *     - Ann (L1 "Analyst", CLIN level, 100.00; a dated change to 110.00 on 2026-03-03):
 *         Mar 2: revision 1 = 5.00, revision 2 = 8.00 (latest)  → 8.00 × 100.00 =   800.00
 *         Mar 3: 7.50                                            → 7.50 × 110.00 =   825.00
 *     - Ben (L2 "Engineer", SLIN 0001AA level, 149.35): SLIN 0001AA, Mar 2: 6.25 → 933.4375
 *     - Cal (no category): Mar 2: 4.00 → unpriced (no-category)
 *     CLIN: hours 25.75; priced cost 2,558.4375 → 2,558.44 (rounded per CLIN); unpriced 4.00
 *     SLIN 0001AA "Migration" (funded 20,000.00): hours 6.25; priced cost 933.44; unpriced 0
 *   CLIN 0002 "Option year" (funded 20,000.00)
 *     - Ben (L3 "Tester", 90.00): Mar 2: 2.00 → 180.00
 *     - Dee (L3 and L4 "Lead" 95.00, overlapping): Mar 2: 5.00 → unpriced (conflict)
 *     CLIN: hours 7.00; priced cost 180.00; unpriced 5.00
 *   Contract: hours 32.75; priced cost 2,738.44; unpriced 9.00
 * Bravo Legacy (closed, sub; funded 50,000.00)
 *   CLIN 0001 (funded 50,000.00): Ann (L5 80.00) Mar 2: 2.00 → 160.00; Cal Mar 3: 1.50 → unpriced
 *   Contract: hours 3.50; priced cost 160.00; unpriced 1.50
 * Charlie New (active, prime; funded 25,000.00): no CLINs → all zeros
 * Indirect: Ann, 8.00 on an overhead code, Mar 2 (no CLIN) — never counted anywhere.
 *
 * Active-only totals: 2 contracts, funded 125,000.00, priced cost 2,738.44. Unpriced over ALL contracts: 10.50.
 */
export async function seedContractsC1Fixture() {
  const db = getTestDb();
  const [ann, ben, cal, dee] = await Promise.all(['Ann Analyst', 'Ben Builder', 'Cal Nocat', 'Dee Double']
    .map((fullName) => createTestUser({ fullName })));

  const alpha = await createTestContract({
    contractNumber: 'C1-ALPHA', name: 'Alpha Support', contractType: 'prime', status: 'active',
    fundedValue: '100000.00', ceilingValue: '150000.00', startDate: '2026-01-01', endDate: '2026-12-31',
  });
  const bravo = await createTestContract({ contractNumber: 'C1-BRAVO', name: 'Bravo Legacy', contractType: 'sub', status: 'closed', fundedValue: '50000.00' });
  const charlie = await createTestContract({ contractNumber: 'C1-CHARLIE', name: 'Charlie New', contractType: 'prime', status: 'active', fundedValue: '25000.00' });

  const a1 = await createTestClin(alpha.id, { clinNumber: '0001', description: 'Base year', fundedAmount: '60000.00' });
  const a2 = await createTestClin(alpha.id, { clinNumber: '0002', description: 'Option year', fundedAmount: '20000.00' });
  const b1 = await createTestClin(bravo.id, { clinNumber: '0001', fundedAmount: '50000.00' });
  const [s1] = await db.insert(schema.slins).values({ clinId: a1.id, slinNumber: '0001AA', description: 'Migration', fundedAmount: '20000.00' }).returning();

  const lcat = async (clinId: string, lcatCode: string, hourlyRate: string, slinId: string | null = null) =>
    (await db.insert(schema.laborCategories).values({ clinId, slinId, lcatCode, title: lcatCode, hourlyRate }).returning())[0];
  const l1 = await lcat(a1.id, 'L1', '100.00');
  const l2 = await lcat(a1.id, 'L2', '149.35', s1.id);
  const l3 = await lcat(a2.id, 'L3', '90.00');
  const l4 = await lcat(a2.id, 'L4', '95.00');
  const l5 = await lcat(b1.id, 'L5', '80.00');
  await db.insert(schema.laborCategoryRates).values({ laborCategoryId: l1.id, effectiveDate: '2026-03-03', hourlyRate: '110.00' });

  const assign = (userId: string, laborCategoryId: string) =>
    db.insert(schema.userLaborCategories).values({ userId, laborCategoryId, effectiveDate: '2026-01-01' });
  await assign(ann.id, l1.id);
  await assign(ben.id, l2.id);
  await assign(ben.id, l3.id);
  await assign(dee.id, l3.id);
  await assign(dee.id, l4.id);
  await assign(ann.id, l5.id);

  const ccA1 = await createTestChargeCode(a1.id, { code: 'C1-A1' });
  const ccA1S1 = await createTestChargeCode(a1.id, { code: 'C1-A1-AA', slinId: s1.id });
  const ccA2 = await createTestChargeCode(a2.id, { code: 'C1-A2' });
  const ccB1 = await createTestChargeCode(b1.id, { code: 'C1-B1' });
  const overhead = await createTestIndirectCode({ code: 'C1-OH', category: 'overhead' });

  const entry = (userId: string, code: { id: string; clinId: string; slinId: string | null }, entryDate: string, hours: string, revisionNumber = 1) =>
    db.insert(schema.timesheetEntries).values({
      userId, chargeCodeId: code.id, clinId: code.clinId, slinId: code.slinId, entryDate, hours, revisionNumber, createdBy: userId,
    });
  await entry(ann.id, ccA1, '2026-03-02', '5.00', 1);
  await entry(ann.id, ccA1, '2026-03-02', '8.00', 2);
  await entry(ann.id, ccA1, '2026-03-03', '7.50');
  await entry(ben.id, ccA1S1, '2026-03-02', '6.25');
  await entry(cal.id, ccA1, '2026-03-02', '4.00');
  await entry(ben.id, ccA2, '2026-03-02', '2.00');
  await entry(dee.id, ccA2, '2026-03-02', '5.00');
  await entry(ann.id, ccB1, '2026-03-02', '2.00');
  await entry(cal.id, ccB1, '2026-03-03', '1.50');
  await db.insert(schema.timesheetEntries).values({
    userId: ann.id, indirectCodeId: overhead.id, entryDate: '2026-03-02', hours: '8.00', revisionNumber: 1, createdBy: ann.id,
  });

  return { alpha, bravo, charlie, a1, a2, b1, s1, users: { ann, ben, cal, dee } };
}

/**
 * The C-1 expected values. Hand-derived from the fixture (above); confirmed against the old getContractSummaries by the
 * recorder before it was removed. Per contract (by name): [hours, priced cost, unpriced hours]; per CLIN / SLIN the same.
 */
export const C1_EXPECTED = {
  contracts: {
    'Alpha Support': { hours: 32.75, pricedCost: 2738.44, unpricedHours: 9 },
    'Bravo Legacy': { hours: 3.5, pricedCost: 160, unpricedHours: 1.5 },
    'Charlie New': { hours: 0, pricedCost: 0, unpricedHours: 0 },
  },
  clins: {
    'Alpha Support/0001': { hours: 25.75, pricedCost: 2558.44, unpricedHours: 4 },
    'Alpha Support/0002': { hours: 7, pricedCost: 180, unpricedHours: 5 },
    'Bravo Legacy/0001': { hours: 3.5, pricedCost: 160, unpricedHours: 1.5 },
  },
  slins: {
    'Alpha Support/0001/0001AA': { hours: 6.25, pricedCost: 933.44, unpricedHours: 0 },
  },
  /** Active contracts only, except unpricedHoursAll (all contracts, = Home's unpricedTotal). */
  totals: { activeContracts: 2, funded: 125000, pricedCost: 2738.44, unpricedHoursAll: 10.5 },
} as const;
