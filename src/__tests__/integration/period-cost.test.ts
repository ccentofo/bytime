import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-kit-contracts.md §4.5 / R-2: the "Cost by pay period" download against the real database. Today is
 * 2026-12-15 (New York); the schedule changes from weekly to semimonthly on Nov 16, so the last 3 completed periods are
 * Nov 2 – 8, Nov 9 – 15 (weekly) and Nov 16 – 30 (semimonthly). Entries bucket by period; rounding is per CLIN per
 * period, then per contract; indirect time and superseded revisions are never counted; the sheet carries the CO-D7
 * note; no hours → 422; a non-admin → 403.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
const h = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const user = async () => ({ id: '00000000-0000-4000-8000-0000000000aa', email: 'a@x', fullName: 'A', role: h.role });
  return {
    ...actual, requireSession: user,
    requireAdmin: async () => { if (h.role !== 'admin') throw new actual.AuthorizationError('forbidden', 'Forbidden'); return user(); },
  };
});

import { GET } from '@/app/api/reports/period-cost-xlsx/route';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';

const db = () => getTestDb();
const req = (n: string, ip: string) => new NextRequest(`http://localhost/api/reports/period-cost-xlsx?n=${n}`, { headers: { 'x-forwarded-for': ip } });

async function sheetValues(res: Response): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Cost by pay period']);
  return (wb.worksheets[0].getSheetValues() as unknown[][]).filter(Boolean).map((r) => r.slice(1));
}

describe('period-cost-xlsx (R-2)', () => {
  beforeEach(async () => {
    await cleanupTestData();
    h.role = 'admin';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T17:00:00Z'));
    await db().insert(schema.payPeriodConfig).values([
      { periodType: 'weekly', anchorDate: '2026-01-05', weekStartDay: 1, effectiveFrom: '1900-01-01' },
      { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '2026-11-16' },
    ]);
  });
  afterEach(async () => { vi.useRealTimers(); await cleanupTestData(); });

  it('buckets across the schedule change, rounds per CLIN per period, skips indirect and superseded hours, carries the note', async () => {
    const army = await createTestContract({ name: 'Army IT Support', contractNumber: 'W1' });
    const c1 = await createTestClin(army.id, { clinNumber: '0001' });
    const c2 = await createTestClin(army.id, { clinNumber: '0002' });
    const emp = await createTestUser({ role: 'employee' });
    const admin = await createTestUser({ role: 'admin' });
    // A CLIN-level category on each CLIN: $0.01/hr, so 0.25 h + 0.25 h on c1 = 0.005 → 0.01, and 0.5 h on c2 → 0.005 → 0.01.
    const [lc1] = await db().insert(schema.laborCategories).values({ clinId: c1.id, lcatCode: 'P1', title: 'P1', hourlyRate: '0.01' }).returning();
    const [lc2] = await db().insert(schema.laborCategories).values({ clinId: c2.id, lcatCode: 'P2', title: 'P2', hourlyRate: '0.01' }).returning();
    await db().insert(schema.userLaborCategories).values([
      { userId: emp.id, laborCategoryId: lc1.id, effectiveDate: '2026-01-01', assignedBy: admin.id },
      { userId: emp.id, laborCategoryId: lc2.id, effectiveDate: '2026-01-01', assignedBy: admin.id },
    ]);
    const code1 = await createTestChargeCode(c1.id);
    const code2 = await createTestChargeCode(c2.id);
    const overhead = await createTestIndirectCode();
    const e = (o: { chargeCodeId?: string; clinId?: string; indirectCodeId?: string; entryDate: string; hours: string; revisionNumber?: number }) =>
      ({ userId: emp.id, createdBy: emp.id, revisionNumber: 1, ...o });
    await db().insert(schema.timesheetEntries).values([
      e({ chargeCodeId: code1.id, clinId: c1.id, entryDate: '2026-11-03', hours: '0.25' }),
      e({ chargeCodeId: code1.id, clinId: c1.id, entryDate: '2026-11-04', hours: '0.25' }),
      e({ chargeCodeId: code2.id, clinId: c2.id, entryDate: '2026-11-05', hours: '0.50' }),
      e({ chargeCodeId: code1.id, clinId: c1.id, entryDate: '2026-11-15', hours: '9' }),                     // superseded …
      e({ chargeCodeId: code1.id, clinId: c1.id, entryDate: '2026-11-15', hours: '8', revisionNumber: 2 }),  // … by this
      e({ chargeCodeId: code1.id, clinId: c1.id, entryDate: '2026-11-16', hours: '8' }),
      e({ indirectCodeId: overhead.id, entryDate: '2026-11-17', hours: '8' }),                               // indirect: never counted
      e({ chargeCodeId: code1.id, clinId: c1.id, entryDate: '2026-11-01', hours: '40' }),                    // before the 3 periods
    ]);

    const res = await GET(req('3', '203.0.113.91'));
    expect(res.status).toBe(200);
    const values = await sheetValues(res);
    expect(values[2]).toEqual([CURRENT_RATES_NOTE]);
    expect(values.slice(4)).toEqual([
      ['Nov 2 – 8, 2026', 'Army IT Support (W1)', 1, 0.02, 0],
      ['Nov 2 – 8, 2026', 'Total', 1, 0.02, 0],
      ['Nov 9 – 15, 2026', 'Army IT Support (W1)', 8, 0.08, 0],
      ['Nov 9 – 15, 2026', 'Total', 8, 0.08, 0],
      ['Nov 16 – 30, 2026', 'Army IT Support (W1)', 8, 0.08, 0],
      ['Nov 16 – 30, 2026', 'Total', 8, 0.08, 0],
    ]);
  });

  it('no hours in the periods → 422 with the range in words; a non-admin → 403', async () => {
    const res = await GET(req('3', '203.0.113.92'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'No hours recorded between Nov 2 and Nov 30, 2026.' });
    h.role = 'supervisor';
    expect((await GET(req('6', '203.0.113.93'))).status).toBe(403);
  });
});
