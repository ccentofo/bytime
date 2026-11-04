import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema';
import { getTestDb, cleanupTestData, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode } from './helpers';

/**
 * feature-plan-ux-kit-contracts.md §10 U-1, U-1b, U-3 against real Postgres.
 * U-1: entries collapse to the expected groups; totals equal Home with no filters; an indirect entry never counts;
 * truncation keeps exact totals; a SLIN entry decided at the CLIN level gets the CLIN-level pair; other users' data
 * doesn't leak into a group.
 * U-1b: a future overlap with no entries is unattached; totals.overlaps = Home's count; a contract filter drops another
 * contract's pair; a pair whose hours are outside the date filter is out of view.
 * U-3: unpriced-xlsx — three sheets, every group in order, 422 when there's nothing, never 404.
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
  const admin = async () => ({ id: '00000000-0000-4000-8000-0000000000u1', email: 'admin@x', fullName: 'Admin', role: 'admin' });
  return { ...actual, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin, getSessionUser: admin };
});

import { unpricedReport, overlappingAssignments, overlapsInScope, allUnpricedGroups } from '@/server/internal/cost-basis';
import { contractBurnSummary } from '@/server/internal/dashboard';
import { GET } from '@/app/api/reports/unpriced-xlsx/route';

async function seed() {
  const db = getTestDb();
  const [emily, rob, dee, pat] = await Promise.all(['Emily Davis', 'Robert Taylor', 'Dee Future', 'Pat Priced'].map((fullName) => createTestUser({ fullName })));
  const army = await createTestContract({ name: 'Army' });
  const other = await createTestContract({ name: 'Other' });
  const c1 = await createTestClin(army.id, { clinNumber: '0001' });
  const c9 = await createTestClin(other.id, { clinNumber: '0009' });
  const [s1] = await db.insert(schema.slins).values({ clinId: c1.id, slinNumber: '0001AA' }).returning();
  const lc = async (clinId: string, lcatCode: string) => (await db.insert(schema.laborCategories).values({ clinId, lcatCode, title: lcatCode, hourlyRate: '100.00' }).returning())[0];
  const [l3, l4, l5, l6, lp] = [await lc(c1.id, 'L3'), await lc(c1.id, 'L4'), await lc(c9.id, 'L5'), await lc(c9.id, 'L6'), await lc(c1.id, 'LP')];
  const assign = (userId: string, laborCategoryId: string, effectiveDate: string) => db.insert(schema.userLaborCategories).values({ userId, laborCategoryId, effectiveDate });
  await assign(rob.id, l3.id, '2026-01-01');
  await assign(rob.id, l4.id, '2026-02-01');                       // CLIN-level pair for Rob on c1 (overlap from Feb 1)
  await assign(dee.id, l5.id, '2027-01-01');
  await assign(dee.id, l6.id, '2027-02-01');                       // future pair on another contract, no entries
  await assign(pat.id, lp.id, '2026-01-01');                       // Pat is priced
  const code = await createTestChargeCode(c1.id, { code: 'ARMY-0001' });
  const slinCode = await createTestChargeCode(c1.id, { code: 'ARMY-0001-AA', slinId: s1.id });
  const oh = await createTestIndirectCode();
  const entry = (userId: string, c: { id: string; clinId: string; slinId: string | null }, entryDate: string, hours: string) =>
    db.insert(schema.timesheetEntries).values({ userId, chargeCodeId: c.id, clinId: c.clinId, slinId: c.slinId, entryDate, hours, revisionNumber: 1, createdBy: userId });
  await entry(emily.id, code, '2026-03-02', '8.00');
  await entry(emily.id, code, '2026-03-03', '4.50');               // → one no-category group: 12.50 h, 2 entries
  await entry(rob.id, slinCode, '2026-03-04', '6.00');             // on SLIN s1, no SLIN categories → decided at CLIN c1 → conflict
  await entry(pat.id, code, '2026-03-02', '7.00');                 // priced (not unpriced)
  await db.insert(schema.timesheetEntries).values({ userId: emily.id, indirectCodeId: oh.id, entryDate: '2026-03-02', hours: '8.00', revisionNumber: 1, createdBy: emily.id });
  return { emily, rob, army, other, c1, s1, code };
}

describe('unpricedGroups / unpricedReport (U-1, U-1b)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('entries collapse to groups; totals = Home; the indirect entry and the priced one never count', async () => {
    const { emily, rob, code, c1 } = await seed();
    const r = await unpricedReport(getTestDb(), {});
    const byUser = Object.fromEntries(r.groups.map((g) => [g.employeeName, g]));
    expect(byUser['Emily Davis']).toMatchObject({ reason: 'no-category', userId: emily.id, chargeCodeId: code.id, hours: 12.5, entries: 2, first: '2026-03-02', last: '2026-03-03' });
    expect(byUser['Robert Taylor']).toMatchObject({ reason: 'conflict', level: 'clin', userId: rob.id, clinId: c1.id, slinId: null, hours: 6 });
    expect(r.groups).toHaveLength(2);
    expect(r.totals).toMatchObject({ hours: 18.5, groups: 2, employees: 2 });
    const home = await contractBurnSummary(getTestDb());
    expect(r.totals.hours).toBe(Math.round(home.reduce((s, c) => s + c.unpricedHours, 0) * 100) / 100);
  });

  it('a SLIN entry decided at the CLIN level gets its CLIN-level pair (fix: end-overlap with both assignment ids)', async () => {
    await seed();
    const g = (await unpricedReport(getTestDb(), {})).groups.find((x) => x.reason === 'conflict')!;
    expect(g.overlaps).toHaveLength(1);
    expect(g.overlaps[0]).toMatchObject({ level: 'clin', slinId: null });
    expect(g.fix).toMatchObject({ kind: 'end-overlap', assignmentIds: expect.arrayContaining([g.overlaps[0].a.assignmentId, g.overlaps[0].b.assignmentId]) });
  });

  it('UX-4B1-AUDIT M1: SLIN-scoped (with or without the CLIN), the SLIN entry still gets its CLIN-level pair; the Excel lists it', async () => {
    const { c1, s1 } = await seed();
    for (const filters of [{ slinId: s1.id }, { clinId: c1.id, slinId: s1.id }]) {
      const r = await unpricedReport(getTestDb(), filters);
      const g = r.groups.find((x) => x.reason === 'conflict')!;
      expect(g.overlaps, JSON.stringify(filters)).toHaveLength(1);
      expect(g.overlaps[0]).toMatchObject({ level: 'clin', clinId: c1.id, slinId: null });
      expect(g.fix).toMatchObject({ kind: 'end-overlap', assignmentIds: expect.arrayContaining([g.overlaps[0].a.assignmentId, g.overlaps[0].b.assignmentId]) });
      expect(r.totals.overlaps).toBeGreaterThanOrEqual(1);
      expect([...r.unattachedOverlaps, ...r.outOfViewOverlaps]).toEqual([]);
      expect((await overlapsInScope(getTestDb(), filters)).map((p) => p.employeeName)).toEqual(['Robert Taylor']);
      expect((await allUnpricedGroups(getTestDb(), filters)).find((x) => x.reason === 'conflict')!.overlaps).toHaveLength(1);
    }
  });

  it('truncation keeps exact totals', async () => {
    await seed();
    const r = await unpricedReport(getTestDb(), {}, { limit: 1 });
    expect(r.truncated).toBe(true);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].employeeName).toBe('Emily Davis');           // the largest first
    expect(r.totals).toMatchObject({ hours: 18.5, groups: 2 });
  });

  it('U-1b: the future pair is unattached; totals.overlaps = Home; a contract filter drops it; a date filter puts Rob\'s pair out of view', async () => {
    const { army } = await seed();
    const all = await unpricedReport(getTestDb(), {});
    expect(all.unattachedOverlaps.map((p) => p.employeeName)).toEqual(['Dee Future']);
    expect(all.totals.overlaps).toBe((await overlappingAssignments(getTestDb())).length);
    const scoped = await unpricedReport(getTestDb(), { contractId: army.id });
    expect(scoped.unattachedOverlaps).toEqual([]);
    expect(scoped.totals.overlaps).toBe(1);
    const june = await unpricedReport(getTestDb(), { startDate: '2026-06-01', endDate: '2026-06-30' });
    expect(june.groups).toEqual([]);
    expect(june.outOfViewOverlaps.map((p) => p.employeeName)).toEqual(['Robert Taylor']);
    expect(june.unattachedOverlaps.map((p) => p.employeeName)).toEqual(['Dee Future']);
  });
});

describe('unpriced-xlsx (U-3)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });
  const req = (q = '', ip = '203.0.113.90') => new NextRequest(`http://localhost/api/reports/unpriced-xlsx${q}`, { headers: { 'x-forwarded-for': ip } });

  it('three sheets; every group, in the report\'s order', async () => {
    await seed();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['To fix', 'Overlaps', 'Every entry']);
    const names: string[] = [];
    wb.getWorksheet('To fix')!.eachRow((r, i) => { if (i > 4) names.push(String(r.getCell(2).value)); });
    expect(names).toEqual(['Emily Davis', 'Robert Taylor']);
  });

  it('422 when there is nothing to fix and no overlaps; an unknown contract is 422 too, never 404; an invalid id is 400', async () => {
    expect((await GET(req('', '203.0.113.91'))).status).toBe(422);
    expect((await GET(req('?contractId=99999999-9999-4999-8999-999999999999', '203.0.113.92'))).status).toBe(422);
    expect((await GET(req('?contractId=nope', '203.0.113.93'))).status).toBe(400);
  });
});
