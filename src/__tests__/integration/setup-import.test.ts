import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { count, eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, cleanupTestData, expectOk, expectFailure } from './helpers';
import type { ActionResult } from '@/lib/action-result';

/**
 * feature-plan-ux-setup-import.md §4.3 (the setup imports, existing types) against Postgres:
 * IM-1  dryRun writes nothing (counts before = after, no admin_change_log rows, no passwords) — People, Contracts, CLINs,
 *       Labor categories, Approval scope (charge codes and access: commit 4).
 * IM-2  the dry run's result equals the real import's on the same data (each type).
 * IM-3  a forced database error in one row → that row reported, the others imported (contracts, CLINs, labor categories).
 * IM-4  row numbers are spreadsheet rows (row 2 = the first data row), and the browser's numbers survive its own skips.
 * IM-5  People: unknown role / FLSA "maybe" → errors; an existing email → skipped with its reason.
 * IM-6  Contracts: blank optional columns accepted; Type "joint" → error.
 * IM-9  over 1,000 rows refused on the server.
 * IM-15 a NUL in a lookup column: the dry run and the import both report that row only; the others succeed in both.
 * IM-16 skippedRows lists existing records with reasons.
 * IM-17 a CLIN onto an inactive contract is refused (shared validator); the contract-number validator is applied.
 * IM-21 "1,000,000" Funded Value refused with the plain-number message (nothing saved); a rate "1,450.00" refused.
 * IM-22 a NUL in a People email → that row errors in the check and the import; the other rows proceed.
 * (IM-18, 501 approval-scope rows: approval-scope.test.ts AS-12.)
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000c3', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'test-tenant.localhost' }) }));
const sessionState = vi.hoisted(() => ({ user: null as null | { id: string; role: string; email: string; fullName: string } }));
vi.mock('@/auth', () => ({ auth: async () => (sessionState.user ? { user: { ...sessionState.user, tenantSlug: 'test-tenant' } } : null) }));
vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
}));

import {
  bulkImportAssignments, bulkImportClins, bulkImportContracts, bulkImportEmployees, bulkImportLaborCategories, type ImportResult,
} from '@/server/actions/import';

const db = () => getTestDb();
const stamp = () => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

async function counts() {
  const n = async (t: typeof schema.users | typeof schema.contracts | typeof schema.clins | typeof schema.laborCategories | typeof schema.approvalScopes | typeof schema.adminChangeLog) =>
    Number((await db().select({ n: count() }).from(t))[0].n);
  return {
    users: await n(schema.users), contracts: await n(schema.contracts), clins: await n(schema.clins),
    laborCategories: await n(schema.laborCategories), approvalScopes: await n(schema.approvalScopes), log: await n(schema.adminChangeLog),
  };
}

/** IM-1 + IM-2: the check writes nothing and returns no passwords; the real import then returns the same result. */
async function checkThenImport(run: (opts: { dryRun?: boolean }) => Promise<ActionResult<ImportResult>>) {
  const before = await counts();
  const check = await expectOk(run({ dryRun: true }));
  expect(await counts()).toEqual(before);
  expect(check.generatedPasswords ?? []).toEqual([]);
  const real = await expectOk(run({}));
  const strip = ({ generatedPasswords: _p, ...rest }: ImportResult) => rest;
  expect(strip(check)).toEqual(strip(real));
  return { check, real, before };
}

/** A real database error (a trigger) for one value, inside that row's savepoint. */
async function withFailingInsert<T>(table: string, column: string, value: string, fn: () => Promise<T>): Promise<T> {
  await db().execute(sql.raw(`CREATE OR REPLACE FUNCTION test_import_fail() RETURNS trigger AS $$ BEGIN IF NEW.${column} = '${value}' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`));
  await db().execute(sql.raw(`CREATE TRIGGER test_import_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_import_fail()`));
  try {
    return await fn();
  } finally {
    await db().execute(sql.raw(`DROP TRIGGER IF EXISTS test_import_fail ON ${table}`));
    await db().execute(sql.raw('DROP FUNCTION IF EXISTS test_import_fail()'));
  }
}

let admin: Awaited<ReturnType<typeof createTestUser>>;
beforeEach(async () => {
  await cleanupTestData();
  admin = await createTestUser({ role: 'admin', email: `imp-admin-${stamp()}@bytime.dev` });
  sessionState.user = { id: admin.id, role: admin.role, email: admin.email, fullName: admin.fullName };
});
afterEach(async () => { sessionState.user = null; await cleanupTestData(); });

describe('setup imports: the check (dry run) and the import (§4.3)', () => {
  it('IM-1/2/5/16 People: the check writes nothing; same result as the import; role, FLSA, existing email', async () => {
    const existing = await createTestUser({ role: 'employee', email: `imp-old-${stamp()}@bytime.dev` });
    const s = stamp();
    const rows = [
      { row: 2, name: 'New One', email: `new1-${s}@bytime.dev`, role: 'Employee', flsaExempt: 'Yes' },
      { row: 3, name: 'Old', email: existing.email.toUpperCase(), role: 'employee', flsaExempt: 'no' },
      { row: 4, name: 'Bad Role', email: `badrole-${s}@bytime.dev`, role: 'manager', flsaExempt: 'no' },
      { row: 5, name: 'Bad FLSA', email: `badflsa-${s}@bytime.dev`, role: 'supervisor', flsaExempt: 'maybe' },
      { row: 6, name: 'New Two', email: `new2-${s}@bytime.dev`, role: 'SUPERVISOR', flsaExempt: 'False' },
    ];
    const { real, before } = await checkThenImport((o) => bulkImportEmployees(rows, o));
    expect(real).toMatchObject({ created: 2, skipped: 1 });
    expect(real.errors).toEqual([
      { row: 4, message: 'Role must be Employee, Supervisor or Admin.' },
      { row: 5, message: 'Overtime (FLSA Exempt) must be Yes or No.' },
    ]);
    expect(real.skippedRows).toEqual([{ row: 3, reason: 'Already a user' }]);
    expect(real.generatedPasswords!.map((p) => p.email).sort()).toEqual([`new1-${s}@bytime.dev`, `new2-${s}@bytime.dev`]);
    expect((await counts()).users).toBe(before.users + 2);
    const [two] = await db().select().from(schema.users).where(eq(schema.users.email, `new2-${s}@bytime.dev`));
    expect([two.role, two.flsaExempt]).toEqual(['supervisor', false]);
  });

  it('IM-1/2/6/16/4 Contracts: blank optional columns accepted; Type "joint" refused; existing skipped; spreadsheet rows', async () => {
    const old = await createTestContract({ contractNumber: `K-OLD-${stamp()}` });
    const s = stamp();
    // No `row` sent: the array position becomes the spreadsheet row (index + 2).
    const rows = [
      { contractNumber: `K1-${s}`, name: 'Blank optionals', type: '', fundedValue: '', ceilingValue: '', startDate: '', endDate: '' },
      { contractNumber: `K2-${s}`, name: 'Joint', type: 'joint' },
      { contractNumber: old.contractNumber, name: 'Again' },
      { contractNumber: `K3-${s}`, name: 'Sub', type: 'SUB', fundedValue: '1250000.00', ceilingValue: '2000000', startDate: '2026-01-01', endDate: '2026-12-31' },
    ];
    const { real } = await checkThenImport((o) => bulkImportContracts(rows, o));
    expect(real).toMatchObject({ created: 2, skipped: 1 });
    expect(real.errors).toEqual([{ row: 3, message: 'Type must be blank (prime), prime or sub.' }]);
    expect(real.skippedRows).toEqual([{ row: 4, reason: 'Contract already exists' }]);
    const [k1] = await db().select().from(schema.contracts).where(eq(schema.contracts.contractNumber, `K1-${s}`));
    expect([k1.contractType, k1.fundedValue, k1.ceilingValue, k1.startDate, k1.endDate]).toEqual(['prime', null, null, null, null]);
    const [k3] = await db().select().from(schema.contracts).where(eq(schema.contracts.contractNumber, `K3-${s}`));
    expect([k3.contractType, Number(k3.fundedValue), k3.startDate]).toEqual(['sub', 1250000, '2026-01-01']);
  });

  it('IM-1/2/16/17 CLINs: an inactive contract refused by the shared validator; CLIN number validated; existing skipped', async () => {
    const k = await createTestContract({ contractNumber: `KC-${stamp()}` });
    const closed = await createTestContract({ contractNumber: `KX-${stamp()}`, status: 'closed' as never });
    await createTestClin(k.id, { clinNumber: '0001' });
    const rows = [
      { row: 2, contractNumber: k.contractNumber, clinNumber: '0002', description: 'Labor', fundedAmount: '50000' },
      { row: 3, contractNumber: k.contractNumber, clinNumber: '0001' },
      { row: 4, contractNumber: closed.contractNumber, clinNumber: '0001' },
      { row: 5, contractNumber: k.contractNumber, clinNumber: 'X'.repeat(51) },
      { row: 6, contractNumber: 'NOPE', clinNumber: '0001' },
    ];
    const { real } = await checkThenImport((o) => bulkImportClins(rows, o));
    expect(real).toMatchObject({ created: 1, skipped: 1 });
    expect(real.skippedRows).toEqual([{ row: 3, reason: 'CLIN already exists on this contract' }]);
    expect(real.errors.map((e) => e.row)).toEqual([4, 5, 6]);
    expect(real.errors[0].message).toBe("This contract isn't active. Reopen it before adding CLINs.");
    expect(real.errors[1].message).toMatch(/^CLIN number /);
    expect(real.errors[2].message).toBe('Contract "NOPE" not found');
  });

  it('IM-17: the contract-number validator is applied to a contract import (not a database error)', async () => {
    const r = await expectOk(bulkImportContracts([{ contractNumber: 'K'.repeat(51), name: 'Long' }]));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/^Contract number /);
  });

  it('IM-1/2/16/21 Labor categories: plain-number rates; existing skipped; nothing coerced', async () => {
    const k = await createTestContract({ contractNumber: `KL-${stamp()}` });
    const c = await createTestClin(k.id, { clinNumber: '0001' });
    await db().insert(schema.laborCategories).values({ clinId: c.id, lcatCode: 'OLD', title: 'Old', hourlyRate: '100.00', status: 'active' });
    const row = (o: Record<string, unknown>) => ({ contractNumber: k.contractNumber, clinNumber: '0001', lcatCode: 'L', title: 'T', hourlyRate: '145', ...o });
    const rows = [
      row({ row: 2, lcatCode: 'SE1' }),
      row({ row: 3, lcatCode: 'SE2', hourlyRate: '1,450.00' }),
      row({ row: 4, lcatCode: 'OLD' }),
      row({ row: 5, lcatCode: 'SE3', hourlyRate: '' }),
      row({ row: 6, lcatCode: 'SE4', ceilingRate: '160.5' }),
    ];
    const { real } = await checkThenImport((o) => bulkImportLaborCategories(rows, o));
    expect(real).toMatchObject({ created: 2, skipped: 1 });
    expect(real.errors).toEqual([
      { row: 3, message: 'Hourly Rate must be a plain number (for example 145.00).' },
      { row: 5, message: 'Hourly Rate is required.' },
    ]);
    expect(real.skippedRows).toEqual([{ row: 4, reason: 'Labor category already exists on this CLIN' }]);
    const codes = (await db().select({ code: schema.laborCategories.lcatCode }).from(schema.laborCategories)).map((r) => r.code).sort();
    expect(codes).toEqual(['OLD', 'SE1', 'SE4']);
  });

  it('IM-1/2/16 Approval scope: the check grants nothing and logs nothing; same result; existing skipped', async () => {
    const k = await createTestContract({ contractNumber: `KS-${stamp()}` });
    const [c1, c2, c3] = [await createTestClin(k.id, { clinNumber: '0001' }), await createTestClin(k.id, { clinNumber: '0002' }), await createTestClin(k.id, { clinNumber: '0003' })];
    const sup = await createTestUser({ role: 'supervisor', email: `imp-sup-${stamp()}@bytime.dev` });
    await db().insert(schema.approvalScopes).values({ supervisorId: sup.id, clinId: c1.id, isActive: true, source: 'app', grantedAt: new Date(), grantedBy: admin.id, reviewedAt: new Date() });
    // A converted scope nobody has reviewed: re-importing it keeps it (approval-scope L4), and the reason says so.
    const [converted] = await db().insert(schema.approvalScopes).values({ supervisorId: sup.id, clinId: c3.id, isActive: true, source: 'migration', reviewedAt: null }).returning();
    const rows = [
      { row: 2, email: sup.email, contractNumber: k.contractNumber, clinNumber: '0001' },
      { row: 3, email: sup.email, contractNumber: k.contractNumber, clinNumber: '0002' },
      { row: 4, email: 'nobody@bytime.dev', contractNumber: k.contractNumber, clinNumber: '0002' },
      { row: 5, email: sup.email, contractNumber: k.contractNumber, clinNumber: '0003' },
    ];
    const { real } = await checkThenImport((o) => bulkImportAssignments(rows, o));
    expect(real).toMatchObject({ created: 1, skipped: 2, errors: [{ row: 4, message: 'User "nobody@bytime.dev" not found' }] });
    expect(real.skippedRows).toEqual([{ row: 2, reason: 'Already approves this CLIN' }, { row: 5, reason: 'Already approves this CLIN (now marked as kept)' }]);
    const held = await db().select({ clinId: schema.approvalScopes.clinId }).from(schema.approvalScopes).where(eq(schema.approvalScopes.isActive, true));
    expect(held.map((r) => r.clinId).sort()).toEqual([c1.id, c2.id, c3.id].sort());
    const [kept] = await db().select().from(schema.approvalScopes).where(eq(schema.approvalScopes.id, converted.id));
    expect(kept.reviewedAt).not.toBeNull();
  });
});

describe('setup imports: one transaction, a savepoint per row (§4.3)', () => {
  it('IM-3: a forced database error in one row → that row reported, the others imported (contracts, CLINs, labor categories)', async () => {
    const s = stamp();
    const contractsResult = await withFailingInsert('contracts', 'contract_number', `KF2-${s}`, () => expectOk(bulkImportContracts([
      { contractNumber: `KF1-${s}`, name: 'One' }, { contractNumber: `KF2-${s}`, name: 'Two' }, { contractNumber: `KF3-${s}`, name: 'Three' },
    ])));
    expect(contractsResult).toMatchObject({ created: 2, errors: [{ row: 3, message: 'Could not import this row.' }] });

    const clinsResult = await withFailingInsert('clins', 'clin_number', '0002', () => expectOk(bulkImportClins(
      ['0001', '0002', '0003'].map((clinNumber) => ({ contractNumber: `KF1-${s}`, clinNumber })),
    )));
    expect(clinsResult).toMatchObject({ created: 2, errors: [{ row: 3, message: 'Could not import this row.' }] });

    const lcatResult = await withFailingInsert('labor_categories', 'lcat_code', 'B', () => expectOk(bulkImportLaborCategories(
      ['A', 'B', 'C'].map((lcatCode) => ({ contractNumber: `KF1-${s}`, clinNumber: '0001', lcatCode, title: lcatCode, hourlyRate: '100' })),
    )));
    expect(lcatResult).toMatchObject({ created: 2, errors: [{ row: 3, message: 'Could not import this row.' }] });
    expect((await counts())).toMatchObject({ contracts: 2, clins: 2, laborCategories: 2 });
  });

  it('IM-15: a NUL in a lookup column → the check and the import report that row only; the other rows succeed in both', async () => {
    const k = await createTestContract({ contractNumber: `KN-${stamp()}` });
    const rows = [
      { row: 2, contractNumber: k.contractNumber, clinNumber: '0001' },
      { row: 3, contractNumber: `${k.contractNumber}\u0000`, clinNumber: '0002' },
      { row: 4, contractNumber: k.contractNumber, clinNumber: '0003' },
    ];
    const { check, real } = await checkThenImport((o) => bulkImportClins(rows, o));
    for (const r of [check, real]) expect(r).toMatchObject({ created: 2, errors: [{ row: 3, message: 'Row 3 contains an invalid character.' }] });
  });

  it('IM-22: a NUL in a People email → that row errors in the check and the import; the other rows proceed', async () => {
    const s = stamp();
    const rows = [
      { row: 2, name: 'Ok One', email: `ok1-${s}@bytime.dev`, role: 'employee', flsaExempt: 'no' },
      { row: 3, name: 'Bad Role', email: `bad-${s}@bytime.dev`, role: 'boss', flsaExempt: 'no' },
      { row: 4, name: 'Nul', email: `nul-${s}\u0000@bytime.dev`, role: 'employee', flsaExempt: 'no' },
      { row: 5, name: 'Ok Two', email: `ok2-${s}@bytime.dev`, role: 'employee', flsaExempt: 'no' },
    ];
    const { check, real } = await checkThenImport((o) => bulkImportEmployees(rows, o));
    // Errors come back in spreadsheet order (the NUL row is refused first, before the value checks).
    for (const r of [check, real]) {
      expect(r).toMatchObject({ created: 2 });
      expect(r.errors).toEqual([{ row: 3, message: 'Role must be Employee, Supervisor or Admin.' }, { row: 4, message: 'Row 4 contains an invalid character.' }]);
    }
  });

  it('IM-4: the browser\'s row numbers are kept (rows it already skipped leave gaps); without them, index + 2', async () => {
    const r = await expectOk(bulkImportContracts([
      { row: 2, contractNumber: `KR-${stamp()}`, name: 'Fine' },
      { row: 7, contractNumber: `KR2-${stamp()}`, name: 'Bad', type: 'joint' },
      { row: 11, contractNumber: '', name: 'No number' },
    ], { dryRun: true }));
    expect(r.errors.map((e) => e.row)).toEqual([7, 11]);
    const unnumbered = await expectOk(bulkImportContracts([{ contractNumber: `KR3-${stamp()}`, name: 'Bad', type: 'joint' }], { dryRun: true }));
    expect(unnumbered.errors).toEqual([{ row: 2, message: 'Type must be blank (prime), prime or sub.' }]);
  });

  it('IM-21: "1,000,000" as Funded Value is refused with the plain-number message and nothing is saved', async () => {
    const s = stamp();
    const r = await expectOk(bulkImportContracts([{ contractNumber: `KM-${s}`, name: 'Commas', fundedValue: '1,000,000' }]));
    expect(r).toMatchObject({ created: 0, errors: [{ row: 2, message: 'Funded Value must be a plain number (for example 1250000.00).' }] });
    expect(await db().select().from(schema.contracts).where(eq(schema.contracts.contractNumber, `KM-${s}`))).toEqual([]);
  });

  it('IM-9: over 1,000 rows refused on the server (before any write)', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ contractNumber: `KB-${i}`, name: 'Bulk' }));
    await expectFailure(bulkImportContracts(rows), 'validation', /^This file has 1001 rows\. Split it into files of 1000 rows or fewer\.$/);
    await expectFailure(bulkImportEmployees(rows as never, { dryRun: true }), 'validation', /^This file has 1001 rows\./);
    expect((await counts()).contracts).toBe(0);
  });
});
