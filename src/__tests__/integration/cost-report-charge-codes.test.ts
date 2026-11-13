import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestIndirectCode, createTestContract, createTestClin, createTestChargeCode, createTestCostClass,
  cleanupTestData,
} from './helpers';

/**
 * feature-plan-excel-cost-report.md §11 T1–T7: getDetailedCostReportData against real Postgres. Each row carries its
 * charge code and that code's Class TODAY (E3), blank with no code (E4); the two new joins are LEFT joins, so the row
 * set, hours, cost and unpriced hours are unchanged (invariant 3); no is_active filter; two codes on one CLIN and day
 * are ordered by code.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
}));

import { getDetailedCostReportData } from '@/server/internal/reports';

const D1 = '2026-03-02';
const D2 = '2026-03-03';
const report = () => getDetailedCostReportData('2026-03-01' as CalendarDate, '2026-03-31' as CalendarDate);

describe('cost report charge code and Class (excel-cost-report T1–T7)', () => {
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let clin: Awaited<ReturnType<typeof createTestClin>>;
  const db = () => getTestDb();
  const entry = (o: Partial<typeof schema.timesheetEntries.$inferInsert>) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, clinId: clin.id, entryDate: D1, hours: '8', revisionNumber: 1, createdBy: emp.id, ...o });

  beforeEach(async () => {
    await cleanupTestData();
    emp = await createTestUser({ role: 'employee' });
    clin = await createTestClin((await createTestContract()).id);
  });
  afterEach(async () => { await cleanupTestData(); });

  it('T1: a code with a Class → chargeCode and className filled', async () => {
    const cls = await createTestCostClass('Government Services');
    const code = await createTestChargeCode(clin.id, { code: 'T1-CODE', classId: cls.id });
    await entry({ chargeCodeId: code.id });
    const rows = await report();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chargeCode: 'T1-CODE', className: 'Government Services' });
  });

  it('T2: a code with no Class → className is null (present as a key)', async () => {
    const code = await createTestChargeCode(clin.id, { code: 'T2-CODE' });
    await entry({ chargeCodeId: code.id });
    const rows = await report();
    expect(rows).toHaveLength(1);
    expect(rows[0].chargeCode).toBe('T2-CODE');
    expect('className' in rows[0]).toBe(true);
    expect(rows[0].className).toBeNull();
  });

  // T3/T4 data: a coded entry on D1 (before the employee's labor category starts → unpriced), a CLIN-only imported
  // entry on D2 (priced at 100/h), and an indirect entry (not in this report, as today).
  async function seedMixed() {
    const lc = (await db().insert(schema.laborCategories).values({ clinId: clin.id, lcatCode: 'SE2', title: 'SE2', hourlyRate: '100.00' }).returning())[0];
    await db().insert(schema.userLaborCategories).values({ userId: emp.id, laborCategoryId: lc.id, effectiveDate: D2 });
    const cls = await createTestCostClass('R&D Programs');
    const code = await createTestChargeCode(clin.id, { code: 'T3-CODE', classId: cls.id });
    const indirect = await createTestIndirectCode();
    await entry({ chargeCodeId: code.id, entryDate: D1, hours: '8' });
    await entry({ chargeCodeId: null, entryDate: D2, hours: '5', source: 'migration' });
    await entry({ clinId: null, indirectCodeId: indirect.id, entryDate: D1, hours: '2' });
  }

  it('T3: a CLIN-only entry stays in the report with blank labels; the indirect entry is absent', async () => {
    await seedMixed();
    const rows = await report();
    expect(rows).toHaveLength(2);
    const clinOnly = rows.find((r) => r.entryDate === D2)!;
    expect(clinOnly).toMatchObject({ chargeCode: null, className: null, totalHours: 5, totalCost: 500, costBasis: 'priced', lcatCode: 'SE2' });
    expect(rows.find((r) => r.entryDate === D1)).toMatchObject({ chargeCode: 'T3-CODE', className: 'R&D Programs', totalHours: 8, totalCost: 0, costBasis: 'unpriced', unpricedHours: 8 });
  });

  it('T4: hours, cost and unpriced hours equal the values computed from the inserted entries', async () => {
    await seedMixed();
    const rows = await report();
    const sum = (k: 'totalHours' | 'totalCost' | 'unpricedHours') => rows.reduce((s, r) => s + r[k], 0);
    expect([sum('totalHours'), sum('totalCost'), sum('unpricedHours')]).toEqual([8 + 5, 5 * 100, 8]);
  });

  it('T5 (E3): after the code\'s Class and code text change, past rows show the new values', async () => {
    const before = await createTestCostClass('Old Class');
    const after = await createTestCostClass('New Class');
    const code = await createTestChargeCode(clin.id, { code: 'T5-OLD', classId: before.id });
    await entry({ chargeCodeId: code.id });
    expect((await report())[0]).toMatchObject({ chargeCode: 'T5-OLD', className: 'Old Class' });
    await db().update(schema.chargeCodes).set({ classId: after.id, code: 'T5-NEW' }).where(eq(schema.chargeCodes.id, code.id));
    expect((await report())[0]).toMatchObject({ chargeCode: 'T5-NEW', className: 'New Class' });
  });

  it('T6: two codes on one CLIN, one employee, one day → two rows in code order', async () => {
    const alpha = await createTestChargeCode(clin.id, { code: 'T6-ALPHA' });
    const bravo = await createTestChargeCode(clin.id, { code: 'T6-BRAVO' });
    // Planning's T6 ruling: BRAVO is inserted first AND has the lower entry id, so without the code key the entry-id
    // tiebreaker puts BRAVO first — the revert check is deterministic.
    await entry({ id: '00000000-0000-4000-8000-000000000001', chargeCodeId: bravo.id });
    await entry({ id: '00000000-0000-4000-8000-000000000002', chargeCodeId: alpha.id });
    const rows = await report();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.clinNumber)).toEqual([clin.clinNumber, clin.clinNumber]);
    expect(rows.map((r) => r.chargeCode)).toEqual(['T6-ALPHA', 'T6-BRAVO']);
  });

  it('T7: an inactive code and an inactive Class still label the hours they covered', async () => {
    const cls = await createTestCostClass('Retired Class');
    const code = await createTestChargeCode(clin.id, { code: 'T7-CODE', classId: cls.id });
    await entry({ chargeCodeId: code.id });
    await db().update(schema.chargeCodes).set({ isActive: false }).where(eq(schema.chargeCodes.id, code.id));
    await db().update(schema.costClasses).set({ isActive: false }).where(eq(schema.costClasses.id, cls.id));
    expect((await report())[0]).toMatchObject({ chargeCode: 'T7-CODE', className: 'Retired Class' });
  });
});
