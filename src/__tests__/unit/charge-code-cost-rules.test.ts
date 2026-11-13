import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

/**
 * feature-plan-certified-outputs.md C3 / §9 rows "Charge code", "Change log", "Corrections (CO-D8)" (reactivate /
 * deactivate logged), "Cost basis" (promotion end date), "Unpriced visibility" (CSV / XLSX / v1 carry the count).
 * Through the real actions with a scripted database; the SQL semantics are in integration/cost-basis.test.ts.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb() as ReturnType<typeof createFakeControlDb> & { transaction: (cb: (tx: unknown) => unknown) => unknown };
  db.transaction = async (cb) => cb(db);
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'admin-1', email: 'a@x', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin, requireApprover: admin, requireApproverFresh: admin };
});
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => '2026-10-25', getWorkspaceTimezone: async () => 'UTC' }));

import * as dbModule from '@/db';
import { adminChangeLog, chargeCodeLaborCategories, chargeCodes, laborCategories, timesheetEntries, userChargeCodes, userLaborCategories } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { deactivateChargeCode, reactivateChargeCode, updateChargeCode } from '@/server/actions/charge-codes';
import { correctChargeCodeCategory } from '@/server/actions/charge-code-categories';
import { endUserLaborCategoryAssignment } from '@/server/actions/labor-categories';
import { generateCostReportExcel, generateEmployeeSummaryExcel } from '@/lib/reports/cost-report-excel';
import type { CostReportEntry } from '@/server/internal/reports';
import { CURRENT_CLASS_NOTE, CURRENT_RATES_NOTE } from '@/lib/cost-labels';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
// UX-4c §3.4: ids are validated as UUIDs.
const CLIN_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CLIN_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SLIN_9 = '99999999-0000-4000-8000-000000000009';
const stored = (o: Record<string, unknown> = {}) => ({ id: 'cc1', clinId: CLIN_A, slinId: null, laborCategoryId: 'lc-1', isActive: true, ...o });
const logs = () => db.inserts.filter((i) => i.table === adminChangeLog).map((i) => i.values);

beforeEach(() => db.reset());

describe('updateChargeCode — a used code\'s CLIN/SLIN never changes; a used code\'s labor category change is logged', () => {
  it('changing the CLIN of a used code is refused', async () => {
    db.onSelect(chargeCodes, [stored()]);
    db.onSelect(timesheetEntries, [{ id: 'e1' }]);
    expect(await updateChargeCode('cc1', { clinId: CLIN_B })).toMatchObject({ ok: false, code: 'validation', error: expect.stringMatching(/CLIN and SLIN can't change/) });
    expect(db.updates).toEqual([]);
  });

  it('changing the SLIN of a used code is refused', async () => {
    db.onSelect(chargeCodes, [stored()]);
    db.onSelect(timesheetEntries, [{ id: 'e1' }]);
    expect(await updateChargeCode('cc1', { slinId: SLIN_9 })).toMatchObject({ ok: false, error: expect.stringMatching(/CLIN and SLIN can't change/) });
  });

  it('the unchanged clinId the form always sends is accepted (no "used" check needed)', async () => {
    db.onSelect(chargeCodes, [stored()]);
    db.onReturning('update', chargeCodes, [stored({ name: 'New name' })]);
    expect(await updateChargeCode('cc1', { clinId: CLIN_A, name: 'New name' })).toMatchObject({ ok: true });
    expect(logs()).toEqual([]);
  });

  it('an unused code with no labor category is editable (CLIN may change)', async () => {
    db.onSelect(chargeCodes, [stored({ laborCategoryId: null })]);
    db.onSelect(timesheetEntries, []);
    db.onSelect(chargeCodeLaborCategories, []);
    db.onReturning('update', chargeCodes, [stored({ clinId: CLIN_B })]);
    expect(await updateChargeCode('cc1', { clinId: CLIN_B })).toMatchObject({ ok: true });
  });

  it('dated rates D3 (DR-Q2): an unused code with a labor category can\'t move to another CLIN', async () => {
    db.onSelect(chargeCodes, [stored()]);
    db.onSelect(timesheetEntries, []);
    db.onSelect(chargeCodeLaborCategories, []);
    expect(await updateChargeCode('cc1', { clinId: CLIN_B })).toEqual({ ok: false, code: 'validation', error: "Remove this charge code's labor categories before moving it to another CLIN or SLIN." });
    expect(db.updates).toEqual([]);
  });

  it('dated rates D3: a used code\'s labor category changes only through the category actions, which log it (old, new)', async () => {
    const CC = '44444444-4444-4444-8444-444444444444';
    const LC2 = '55555555-5555-4555-8555-555555555555';
    db.onSelect(chargeCodes, [{ clinId: CLIN_A, slinId: null, laborCategoryId: 'lc-1' }]); // locked row
    db.onSelect(chargeCodeLaborCategories, []);
    db.onSelect(laborCategories, [{ clinId: CLIN_A, slinId: null }]);                      // DR-Q2 placement
    db.onSelect(timesheetEntries, [{ hours: '8.00' }]);                                     // re-priced hours
    db.onReturning('update', chargeCodes, [{ id: CC }]);
    db.onSelect(chargeCodes, [{ clinId: CLIN_A, slinId: null, laborCategoryId: LC2 }]);   // view
    db.onSelect(chargeCodeLaborCategories, []);
    expect((await correctChargeCodeCategory({ chargeCodeId: CC, target: 'starting', laborCategoryId: LC2, reason: 'rebid' })).ok).toBe(true);
    expect(logs()).toEqual([{
      actorId: 'admin-1', entity: 'charge_code_labor_category', entityId: CC, action: 'category_corrected',
      oldValue: { target: 'starting', laborCategoryId: 'lc-1' },
      newValue: { target: 'starting', effectiveDate: null, laborCategoryId: LC2, reason: 'rebid', period: { from: null, toExclusive: null }, repricedHours: '8.00' },
    }]);
  });

  it('a missing code → not_found', async () => {
    expect(await updateChargeCode('nope', { name: 'x' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('the stored row is locked FOR UPDATE; saves re-read the code FOR SHARE inside their transaction (static)', () => {
    const cc = readFileSync(path.join(ROOT, 'src/server/actions/charge-codes.ts'), 'utf8');
    const update = cc.slice(cc.indexOf('export async function updateChargeCode'), cc.indexOf('export async function deactivateChargeCode'));
    expect(update).toMatch(/tx\.select\(\)\.from\(chargeCodes\)\.where\(eq\(chargeCodes\.id, id\)\)\.for\('update'\)/);
    const ts = readFileSync(path.join(ROOT, 'src/server/actions/timesheet.ts'), 'utf8');
    const save = ts.slice(ts.indexOf('export async function saveTimesheetBatch'));
    const tx = save.slice(save.indexOf('await db.transaction(async (tx) => {'));
    expect(tx.indexOf(".for('share')")).toBeGreaterThan(tx.indexOf('await lockEmployeeTimesheet(tx, userId)'));
    expect(tx.indexOf(".for('share')")).toBeLessThan(tx.indexOf('await tx.insert(timesheetEntries)'));
    expect(tx).toMatch(/for \(const cc of fresh\) chargeCodeCache\.set\(cc\.id, \{ clinId: cc\.clinId, slinId: cc\.slinId \?\? null \}\);/);
  });
});

describe('deactivate / reactivate (CO-D8, ruling Q2)', () => {
  it('deactivating an active code is logged once; an already-inactive code writes nothing', async () => {
    db.onSelect(chargeCodes, [{ isActive: true }]);
    expect((await deactivateChargeCode('cc1')).ok).toBe(true);
    expect(logs()).toEqual([expect.objectContaining({ entity: 'charge_code', entityId: 'cc1', action: 'deactivated', newValue: { isActive: false } })]);
    db.reset();
    db.onSelect(chargeCodes, [{ isActive: false }]);
    expect((await deactivateChargeCode('cc1')).ok).toBe(true);
    expect(logs()).toEqual([]);
  });

  it('reactivating is logged with the number of employees still assigned (they see the code again); assignments untouched', async () => {
    db.onSelect(chargeCodes, [{ isActive: false }]);
    db.onSelect(userChargeCodes, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(await reactivateChargeCode('cc1')).toEqual({ ok: true, data: { stillAssigned: 3 } });
    expect(logs()).toEqual([expect.objectContaining({ action: 'reactivated', newValue: { isActive: true, stillAssigned: 3 } })]);
    expect(db.updates.map((u) => u.table)).toEqual([chargeCodes]); // never user_charge_codes
  });
});

describe('F11 — small cost-view fixes', () => {
  it('the reactivation count (dialog + action) counts ACTIVE employees only', () => {
    const cc = readFileSync(path.join(ROOT, 'src/server/actions/charge-codes.ts'), 'utf8');
    const counts = cc.match(/eq\(userChargeCodes\.chargeCodeId, id\), eq\(userChargeCodes\.isActive, true\), eq\(users\.isActive, true\)/g) ?? [];
    expect(counts).toHaveLength(2);
    expect(cc.match(/\.innerJoin\(users, eq\(userChargeCodes\.userId, users\.id\)\)\s*\/\/ F11/g)).toHaveLength(2);
  });

  // The on-screen period report (and its scoped note) moved to the "Cost by pay period" Excel download (UX-4b R3).
  it('the API-key dialog documents lcatTitle "Unpriced"', () => {
    expect(readFileSync(path.join(ROOT, 'src/app/(app)/settings/api-keys/ApiKeysClient.tsx'), 'utf8')).toMatch(/<Code>lcatTitle<\/Code> is\{' '\}\s*<Code>Unpriced<\/Code>/);
  });
});

describe('endUserLaborCategoryAssignment — optional end date (promotion: end yesterday, start today)', () => {
  const ULC1 = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c'; // a UUID: the id is validated first (UX-4b §4.3)
  it('an explicit end date on/after the effective date is used; before it is refused; default is today', async () => {
    db.onSelect(userLaborCategories, [{ effectiveDate: '2026-01-01' }]);
    db.onReturning('update', userLaborCategories, [{ id: 'ulc1', endDate: '2026-10-24' }]);
    expect((await endUserLaborCategoryAssignment(ULC1, '2026-10-24' as never)).ok).toBe(true);
    expect(db.updates[0].set).toMatchObject({ endDate: '2026-10-24' });

    db.reset();
    db.onSelect(userLaborCategories, [{ effectiveDate: '2026-10-01' }]);
    expect(await endUserLaborCategoryAssignment(ULC1, '2026-09-30' as never)).toMatchObject({ ok: false, code: 'validation', error: expect.stringMatching(/can't be before/) });

    db.reset();
    db.onSelect(userLaborCategories, [{ effectiveDate: '2026-01-01' }]);
    db.onReturning('update', userLaborCategories, [{ id: 'ulc1' }]);
    await endUserLaborCategoryAssignment(ULC1);
    expect(db.updates[0].set).toMatchObject({ endDate: '2026-10-25' });
  });
});

describe('cost exports carry the unpriced count (ruling Q6)', () => {
  const entry = (o: Partial<CostReportEntry>): CostReportEntry => ({
    employeeName: 'Pat', employeeEmail: 'p@x', contractName: 'C', contractNumber: 'N', clinNumber: '0001', slinNumber: null,
    chargeCode: null, className: null, lcatCode: 'SE2', lcatTitle: 'Eng', hourlyRate: 100, totalHours: 8, totalCost: 800, entryDate: '2026-09-01',
    costBasis: 'priced', unpricedReason: null, unpricedHours: 0, ...o,
  });

  async function rows(buffer: Buffer): Promise<unknown[][]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const out: unknown[][] = [];
    wb.worksheets[0].eachRow((r) => out.push((r.values as unknown[]).slice(1)));
    return out;
  }

  it('the detailed XLSX adds the unpriced-hours row and the current-rates note after the totals', async () => {
    const data = [entry({}), entry({ costBasis: 'unpriced', unpricedReason: 'no-category', unpricedHours: 4, totalHours: 4, totalCost: 0, hourlyRate: 0, lcatCode: '—', lcatTitle: 'Unpriced' })];
    const r = await rows(await generateCostReportExcel(data, 'Cost Report', 'Sep'));
    expect(r.find((x) => String(x[0]).startsWith('UNPRICED HOURS'))?.[11]).toBe(4); // excel-cost-report §6.2: hours in column 12
    expect(r.some((x) => x[0] === 'Costs use the labor-category rate in effect on each day worked.')).toBe(true);
  });

  it('the summary XLSX adds them only with the cost column (admins)', async () => {
    const data = [{ employeeId: 'u1', employeeName: 'Pat', contractName: 'C', contractNumber: 'N', clinNumber: '0001', totalHours: 10, totalCost: 600, unpricedHours: 4, flsaExempt: false }];
    expect((await rows(await generateEmployeeSummaryExcel(data, 'Sep', true))).find((x) => String(x[0]).startsWith('UNPRICED HOURS'))?.[4]).toBe(4);
    expect((await rows(await generateEmployeeSummaryExcel(data, 'Sep', false))).some((x) => String(x[0]).startsWith('UNPRICED HOURS'))).toBe(false);
  });

  it('CSV footer and v1 meta carry the total (static)', () => {
    const csv = readFileSync(path.join(ROOT, 'src/app/api/reports/cost-report-csv/route.ts'), 'utf8');
    expect(csv).toMatch(/Unpriced hours \(no applicable labor category; no cost\),\$\{unpriced\}/);
    // large-report-responses §10.1: the body streams (byte identity is cost-report-csv.test.ts T6).
    expect(csv).toMatch(/streamJoined\(\{ head: BOM, items: lines, separator: '\\n', tail: footer \}\)/);
    const v1 = readFileSync(path.join(ROOT, 'src/app/api/v1/costs/route.ts'), 'utf8');
    expect(v1).toMatch(/return apiStreamResponse\(data, \{ total: data\.length, unpricedHours \}\);/);
  });

  // ── feature-plan-excel-cost-report.md ─────────────────────────────────────
  async function sheet(data: CostReportEntry[]): Promise<ExcelJS.Worksheet> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await generateCostReportExcel(data, 'Cost Report', 'Sep')) as unknown as ArrayBuffer);
    return wb.worksheets[0];
  }
  const HEADERS_13 = ['Employee', 'Contract', 'Contract #', 'CLIN', 'SLIN', 'Charge Code', 'Class', 'LCAT Code', 'LCAT Title', 'Rate ($/hr)', 'Date', 'Hours', 'Cost ($)'];

  it('T9: the detailed XLSX has Charge Code and Class after SLIN, totals and unpriced in columns 12/13, the Class note, A1:M1, number formats on 10/12/13 only', async () => {
    const data = [
      entry({ chargeCode: 'NAVAIR-0001-ONSITE', className: 'Government Services' }),
      entry({ chargeCode: null, className: null, totalHours: 2, totalCost: 200 }),
      entry({ costBasis: 'unpriced', unpricedReason: 'no-category', unpricedHours: 4, totalHours: 4, totalCost: 0, hourlyRate: 0, lcatCode: '—', lcatTitle: 'Unpriced' }),
    ];
    const r = await rows(await generateCostReportExcel(data, 'Cost Report', 'Sep'));
    const ws = await sheet(data);
    expect((ws.getRow(3).values as unknown[]).slice(1)).toEqual(HEADERS_13);
    expect(r[3].slice(5, 7)).toEqual(['NAVAIR-0001-ONSITE', 'Government Services']);
    expect(r[4].slice(5, 7)).toEqual(['', '']); // E4: no charge code → blank cells
    const totals = r.find((x) => x[0] === 'TOTALS')!;
    expect([totals.length, totals[11], totals[12]]).toEqual([13, 14, 1000]);
    expect(r.find((x) => String(x[0]).startsWith('UNPRICED HOURS'))?.[11]).toBe(4);
    const notes = r.findIndex((x) => x[0] === CURRENT_RATES_NOTE);
    expect(r[notes + 1]).toEqual([CURRENT_CLASS_NOTE]);
    expect(ws.model.merges).toEqual(expect.arrayContaining(['A1:M1', 'A2:M2']));
    expect(ws.getCell('M1').isMerged).toBe(true);
    expect([ws.getColumn(10).numFmt, ws.getColumn(12).numFmt, ws.getColumn(13).numFmt]).toEqual(['$#,##0.00', '#,##0.00', '$#,##0.00']);
    expect(ws.getColumn(8).numFmt).toBeUndefined();
    expect(ws.getColumn(11).numFmt).toBeUndefined();
  });

  it('T10 (Excel half): a code that looks like a formula and a Class with a comma and quotes are stored as text', async () => {
    const ws = await sheet([entry({ chargeCode: '=1+1', className: 'R&D, "Labs"' })]);
    const code = ws.getRow(4).getCell(6);
    expect(code.type).toBe(ExcelJS.ValueType.String);
    expect(code.value).toBe('=1+1');
    expect(ws.getRow(4).getCell(7).value).toBe('R&D, "Labs"');
  });

  it('T12: the Class note text (Q4), used by the XLSX and the CSV (static)', () => {
    expect(CURRENT_CLASS_NOTE).toBe('Class shows the current Class of each charge code, including on past dates.');
    for (const rel of ['src/lib/reports/cost-report-excel.ts', 'src/app/api/reports/cost-report-csv/route.ts']) {
      expect(readFileSync(path.join(ROOT, rel), 'utf8'), rel).toContain('CURRENT_CLASS_NOTE');
    }
  });

  it('T14 (Q2): the API key dialog describes chargeCode and className (static)', () => {
    const src = readFileSync(path.join(ROOT, 'src/app/(app)/settings/api-keys/ApiKeysClient.tsx'), 'utf8');
    expect(src).toContain('<Code>chargeCode</Code>');
    expect(src).toContain('<Code>className</Code>');
  });

  it('T15 (Q3): the Downloads Contract costs description mentions charge codes (static)', () => {
    const src = readFileSync(path.join(ROOT, 'src/app/(app)/admin/reports/ReportsClient.tsx'), 'utf8');
    expect(src).toContain('Hours and cost by contract, CLIN, charge code and labor category, using the rate in effect each day.');
  });
});
