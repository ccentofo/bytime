import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, navigatePeriod, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode,
  cleanupTestData, expectOk, expectFailure,
} from './helpers';
import { cpReady, makeTenant, setTenant, cleanupLifecycleTenants } from './lifecycle-helpers';

/**
 * feature-plan-certified-outputs.md C1 / §9 rows Window, Periods import dates, Import race / locks, Import guards,
 * Batch integrity, Attribution, Period import, Display (v1 API). Real Postgres; the import reads the control plane for
 * the founder's reopen, so the suite needs CONTROL_PLANE_DATABASE_URL. Writes get their OWN connection per call, so
 * concurrent transactions genuinely race (the shared test client is max: 1).
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const writers: postgres.Sql[] = [];

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => {
    const client = postgres(process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test', { max: 1 });
    writers.push(client);
    return drizzle(client, { schema });
  },
}));

const tenantState = vi.hoisted(() => ({ id: '00000000-0000-4000-8000-0000000000c1' }));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: tenantState.id, slug: 'test-tenant', plan: 'trial', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));

type FakeSessionUser = { id: string; role: 'admin' | 'supervisor' | 'employee'; email: string; fullName: string };
const sessionState = vi.hoisted(() => ({
  user: null as null | FakeSessionUser,
  als: null as null | { getStore(): FakeSessionUser | undefined },
}));
// Concurrent actions by different users: each carries its own actor (AsyncLocalStorage). The session guards are
// stubbed from it (vitest 2.1.9's concurrent-mock-import quirk, see dcaa-concurrency.test.ts); these tests are about
// database locking and import rules, not the guards (covered by the guard tests).
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => {
    const u = sessionState.als?.getStore() ?? sessionState.user;
    if (!u) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return u;
  };
  const admin = () => {
    const u = current();
    if (u.role !== 'admin') throw new actual.AuthorizationError('forbidden', 'Forbidden: Admin role required');
    return u;
  };
  return {
    ...actual,
    getSessionUser: async () => sessionState.als?.getStore() ?? sessionState.user,
    requireSession: async () => current(),
    requireAdmin: async () => admin(),
    requireAdminFresh: async () => admin(),
  };
});
vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
}));

import { importMigrationData, importMigrationPeriods } from '@/server/actions/migration';
import { submitPeriod } from '@/server/actions/periods';
import { saveTimesheetBatch } from '@/server/actions/timesheet';
import { GET as getV1Periods } from '@/app/api/v1/periods/route';
import { GET as getV1Timesheets } from '@/app/api/v1/timesheets/route';
import { IMPORT_WINDOW_CLOSED_MESSAGE } from '@/lib/migration/import-plan';
import type { MigrationEntryRow, MigrationPeriodRow } from '@/types/migration';

const actorStore = new AsyncLocalStorage<FakeSessionUser>();
sessionState.als = actorStore;
const asFake = (u: { id: string; role: string; email: string; fullName: string }): FakeSessionUser =>
  ({ id: u.id, role: u.role as FakeSessionUser['role'], email: u.email, fullName: u.fullName });

const today = () => todayIn('America/New_York');
const currentStart = () => getPeriodStartForDate(today(), DEFAULT_PERIOD_CONFIG);
const prevStart = (n = 1): CalendarDate => {
  let s = currentStart();
  for (let i = 0; i < n; i++) s = navigatePeriod(s, 'prev', DEFAULT_PERIOD_CONFIG);
  return s;
};
const WINDOW_REFUSED = new RegExp(IMPORT_WINDOW_CLOSED_MESSAGE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

describe.skipIf(!cpReady)('migration import (certified-outputs C1)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let employee: Awaited<ReturnType<typeof createTestUser>>;
  let employeeB: Awaited<ReturnType<typeof createTestUser>>;
  let contract: Awaited<ReturnType<typeof createTestContract>>;
  let clin: Awaited<ReturnType<typeof createTestClin>>;
  let indirect: Awaited<ReturnType<typeof createTestIndirectCode>>;

  const entryRow = (o: Partial<MigrationEntryRow> = {}): MigrationEntryRow => ({
    employeeEmail: employee.email, entryDate: addDays(prevStart(4), 1), contractNumber: contract.contractNumber,
    clinNumber: clin.clinNumber, indirectCode: '', hours: '8', changeReason: '', comment: '', createdAt: '', ...o,
  });
  const indirectRow = (o: Partial<MigrationEntryRow> = {}): MigrationEntryRow =>
    entryRow({ contractNumber: '', clinNumber: '', indirectCode: indirect.code, ...o });
  const periodRow = (o: Partial<MigrationPeriodRow> = {}): MigrationPeriodRow => ({
    employeeEmail: employee.email, periodStart: prevStart(4), status: 'approved', submittedAt: '2025-01-16T10:00:00Z',
    reviewedAt: '2025-01-17T10:00:00Z', reviewedByEmail: 'boss@oldsystem.example', reviewComment: 'ok', ...o,
  });
  const importEntries = (rows: MigrationEntryRow[]) =>
    actorStore.run(asFake(admin), () => importMigrationData({ rows, sourceSystem: 'LegacyTime', fileName: 'history.csv' }));
  const importPeriods = (rows: MigrationPeriodRow[]) =>
    actorStore.run(asFake(admin), () => importMigrationPeriods({ rows, sourceSystem: 'LegacyTime', fileName: 'periods.csv' }));
  const entriesOf = (userId: string) => getTestDb().select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, userId));
  const batches = () => getTestDb().select().from(schema.importBatches);
  const closeWindow = () => getTestDb().update(schema.workspaceSettings).set({ historyImportClosedAt: new Date() }).where(eq(schema.workspaceSettings.id, 1));

  /** An app submission by `user` for prevStart(1) (needs one app entry there). */
  async function appSubmit(user: typeof employee, chargeCodeId: string) {
    await getTestDb().insert(schema.timesheetEntries).values({
      userId: user.id, chargeCodeId, clinId: clin.id, entryDate: prevStart(1), hours: '8', revisionNumber: 1, createdBy: user.id,
    });
    return actorStore.run(asFake(user), () => submitPeriod({ periodStart: prevStart(1) }));
  }

  beforeEach(async () => {
    await cleanupTestData();
    tenantState.id = '00000000-0000-4000-8000-0000000000c1';
    admin = await createTestUser({ role: 'admin' });
    employee = await createTestUser({ role: 'employee' });
    employeeB = await createTestUser({ role: 'employee' });
    contract = await createTestContract();
    clin = await createTestClin(contract.id);
    indirect = await createTestIndirectCode();
  });
  afterEach(async () => {
    sessionState.user = null;
    while (writers.length) await writers.pop()!.end({ timeout: 1 }).catch(() => {});
    await cleanupTestData();
  });
  afterAll(async () => {
    while (writers.length) await writers.pop()!.end({ timeout: 1 }).catch(() => {});
    await cleanupLifecycleTenants();
  });

  it('F3: "7,5", "8h" and "" are row errors (never truncated); "7.5" imports as 7.50', async () => {
    const day = (n: number) => addDays(prevStart(4), n);
    const r = await expectOk(importEntries([
      entryRow({ hours: '7,5', entryDate: day(1) }), entryRow({ hours: '8h', entryDate: day(2) }), entryRow({ hours: '', entryDate: day(3) }),
      entryRow({ hours: '7.5', entryDate: day(4) }),
    ]));
    expect(r.imported).toBe(1);
    expect(r.errors.map((e) => e.row).sort()).toEqual([1, 2, 3]);
    for (const e of r.errors) expect(e.message).toMatch(/Hours must be a number between 0 and 24/);
    const rows = await entriesOf(employee.id);
    expect(rows.map((x) => [x.entryDate, Number(x.hours).toFixed(2)])).toEqual([[day(4), '7.50']]);
  });

  // ── Window ──────────────────────────────────────────────────────────────────
  describe('window', () => {
    it('open before any submission', async () => {
      const r = await expectOk(importEntries([entryRow()]));
      expect(r.imported).toBe(1);
    });

    it('closed after the first app submission — refused, nothing written', async () => {
      const code = await createTestChargeCode(clin.id);
      await getTestDb().insert(schema.userChargeCodes).values({ userId: employeeB.id, chargeCodeId: code.id, isActive: true });
      expect((await appSubmit(employeeB, code.id)).ok).toBe(true);
      const [settings] = await getTestDb().select().from(schema.workspaceSettings);
      expect(settings.historyImportClosedAt).not.toBeNull();
      await expectFailure(importEntries([entryRow()]), 'validation', WINDOW_REFUSED);
      expect(await entriesOf(employee.id)).toEqual([]);
      expect(await batches()).toEqual([]);
    });

    it('imported submitted events do not close it', async () => {
      expect((await expectOk(importPeriods([periodRow({ status: 'submitted' })]))).imported).toBe(1);
      const r = await expectOk(importEntries([entryRow({ entryDate: addDays(prevStart(6), 1) })]));
      expect(r.imported).toBe(1);
    });

    it('a tenant with an approved period and NO events is closed after the 0014 backfill', async () => {
      await getTestDb().insert(schema.timesheetPeriods).values({ userId: employeeB.id, periodStart: prevStart(8), status: 'approved', periodNumDays: 15 });
      // Run 0014's backfill statement exactly as shipped.
      const migration = readFileSync(path.resolve(__dirname, '../../../drizzle/0014_certified_outputs.sql'), 'utf8');
      const backfill = migration.split('--> statement-breakpoint').map((s) => s.trim()).find((s) => s.includes('SET "history_import_closed_at" = now()'))!;
      await getTestDb().execute(sql.raw(backfill));
      await expectFailure(importEntries([entryRow()]), 'validation', WINDOW_REFUSED);
    });

    it('old code: an app submitted event without the flag → closed', async () => {
      const [p] = await getTestDb().insert(schema.timesheetPeriods).values({ userId: employeeB.id, periodStart: prevStart(2), status: 'submitted' }).returning();
      await getTestDb().insert(schema.periodEvents).values({ periodId: p.id, userId: employeeB.id, event: 'submitted', actorId: employeeB.id });
      await expectFailure(importEntries([entryRow()]), 'validation', WINDOW_REFUSED);
    });

    it('founder reopen allows until T, refuses after; lock and overlap guards still apply', async () => {
      const tenant = await makeTenant({ importWindowUntil: new Date(Date.now() + 3_600_000) });
      tenantState.id = tenant.id;
      await closeWindow();
      expect((await expectOk(importEntries([entryRow()]))).imported).toBe(1);
      // Overlap still enforced while reopened.
      const again = await expectOk(importEntries([entryRow()]));
      expect(again.imported).toBe(0);
      expect(again.errors[0].message).toMatch(/already has hours on this CLIN/);
      await setTenant(tenant.id, { importWindowUntil: new Date(Date.now() - 1000) });
      await expectFailure(importEntries([entryRow({ entryDate: addDays(prevStart(5), 2) })]), 'validation', WINDOW_REFUSED);
    });
  });

  // ── Periods import dates ────────────────────────────────────────────────────
  describe('periods import dates', () => {
    it('a period ending today or later → row error; draft → row error', async () => {
      const r = await expectOk(importPeriods([periodRow({ periodStart: currentStart() }), periodRow({ periodStart: prevStart(6), status: 'draft' })]));
      expect(r.imported).toBe(0);
      expect(r.errors.map((e) => e.row)).toEqual([1, 2]);
      expect(r.errors[0].message).toMatch(/has not ended yet/);
      expect(r.errors[1].message).toMatch(/Draft periods are not imported/);
    });

    it('entries into an imported approved period → refused (import entries first)', async () => {
      await expectOk(importPeriods([periodRow()]));
      const r = await expectOk(importEntries([entryRow()]));
      expect(r.imported).toBe(0);
      expect(r.errors[0].message).toMatch(/inside an approved period/);
    });
  });

  // ── Import guards ───────────────────────────────────────────────────────────
  describe('import guards', () => {
    it('reopened window: a legacy approved period with no events → entry import refused; app-approved period refused', async () => {
      const tenant = await makeTenant({ importWindowUntil: new Date(Date.now() + 3_600_000) });
      tenantState.id = tenant.id;
      await closeWindow();
      await getTestDb().insert(schema.timesheetPeriods).values({ userId: employee.id, periodStart: prevStart(4), status: 'approved', periodNumDays: 15 });
      const [p] = await getTestDb().insert(schema.timesheetPeriods).values({ userId: employee.id, periodStart: prevStart(6), status: 'approved', periodNumDays: 15 }).returning();
      await getTestDb().insert(schema.periodEvents).values({ periodId: p.id, userId: employee.id, event: 'approved', actorId: admin.id });
      const r = await expectOk(importEntries([entryRow(), entryRow({ entryDate: addDays(prevStart(6), 1) })]));
      expect(r.imported).toBe(0);
      expect(r.errors).toHaveLength(2);
      for (const e of r.errors) expect(e.message).toMatch(/approved period/);
    });

    it('date inside any submitted period → refused', async () => {
      await getTestDb().insert(schema.timesheetPeriods).values({ userId: employee.id, periodStart: prevStart(4), status: 'submitted', periodNumDays: 15 });
      const r = await expectOk(importEntries([entryRow()]));
      expect(r.errors[0].message).toMatch(/submitted period/);
    });

    it('a CLIN/day where the employee has app charge-code hours on that CLIN → refused; same indirect code/day → refused; existing cell → row error', async () => {
      const code = await createTestChargeCode(clin.id);
      const d = addDays(prevStart(4), 1);
      await getTestDb().insert(schema.timesheetEntries).values([
        { userId: employee.id, chargeCodeId: code.id, clinId: clin.id, entryDate: d, hours: '3', revisionNumber: 1, createdBy: employee.id },
        { userId: employee.id, indirectCodeId: indirect.id, entryDate: d, hours: '1', revisionNumber: 1, createdBy: employee.id },
        { userId: employeeB.id, clinId: clin.id, entryDate: d, hours: '2', revisionNumber: 1, createdBy: employeeB.id }, // existing CLIN-only cell
      ]);
      const r = await expectOk(importEntries([entryRow({ entryDate: d }), indirectRow({ entryDate: d }), entryRow({ employeeEmail: employeeB.email, entryDate: d })]));
      expect(r.imported).toBe(0);
      expect(r.errors.map((e) => e.message)).toEqual([
        expect.stringMatching(/already has hours on this CLIN/),
        expect.stringMatching(/already has hours on this indirect code/),
        expect.stringMatching(/already has hours on this CLIN/),
      ]);
    });

    it('future date and today → refused', async () => {
      const r = await expectOk(importEntries([entryRow({ entryDate: today() }), entryRow({ entryDate: addDays(today(), 3) })]));
      expect(r.imported).toBe(0);
      for (const e of r.errors) expect(e.message).toMatch(/must be before today/);
    });
  });

  // ── Batch integrity + attribution ───────────────────────────────────────────
  describe('batch integrity and attribution', () => {
    it('attribution: createdBy = admin, createdAt ≈ now, source migration, batch row, original_metadata (Entered By present/absent)', async () => {
      const before = Date.now();
      const r = await expectOk(importEntries([
        entryRow({ enteredBy: 'pat@oldsystem.example', createdAt: '2025-01-02T17:00:00Z', changeReason: 'CORRECTION', comment: 'fixed' }),
        indirectRow({ entryDate: addDays(prevStart(4), 2) }),
      ]));
      expect(r.imported).toBe(2);
      const rows = (await entriesOf(employee.id)).sort((a, b) => a.entryDate.localeCompare(b.entryDate));
      for (const row of rows) {
        expect(row).toMatchObject({ createdBy: admin.id, source: 'migration', importBatchId: r.batchId, changeReasonCode: 'MIGRATION', revisionNumber: 1 });
        expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5000);
      }
      expect(rows[0].originalMetadata).toEqual({ enteredBy: 'pat@oldsystem.example', enteredAt: '2025-01-02T17:00:00Z', reason: 'CORRECTION', comment: 'fixed' });
      expect(rows[0].comment).toBe('fixed');
      expect(rows[1].originalMetadata).toEqual({ enteredBy: null, enteredAt: null, reason: null, comment: null });
      expect(rows[1].comment).toBe('Imported from LegacyTime');
      const [batch] = await batches();
      expect(batch).toMatchObject({ id: r.batchId, kind: 'entries', sourceSystem: 'LegacyTime', importedBy: admin.id, fileName: 'history.csv', rowCount: 2, importedCount: 2, skippedCount: 0 });
    });

    it('every import_batch_id resolves to a batch row; counts equal rows inserted; in-file duplicate → row error', async () => {
      const r = await expectOk(importEntries([entryRow(), entryRow({ hours: '4' }), indirectRow()]));
      expect(r.imported).toBe(2);
      expect(r.errors).toEqual([{ row: 2, message: expect.stringMatching(/Duplicate of row 1/) }]);
      const orphans = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM timesheet_entries te LEFT JOIN import_batches b ON b.id = te.import_batch_id WHERE te.import_batch_id IS NOT NULL AND b.id IS NULL`);
      expect((orphans as unknown as Array<{ n: number }>)[0].n).toBe(0);
      const [batch] = await batches();
      expect(batch.importedCount).toBe((await entriesOf(employee.id)).length);
      expect(batch).toMatchObject({ rowCount: 3, importedCount: 2, skippedCount: 1 });
    });

    it('a DB error mid-batch → nothing written (batch row included)', async () => {
      const raw = postgres(TEST_DB_URL, { max: 1 });
      try {
        await raw.unsafe(`CREATE OR REPLACE FUNCTION co_test_fail_insert() RETURNS TRIGGER AS $$ BEGIN
          IF NEW.comment = 'FAIL-ME' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
        await raw.unsafe('CREATE TRIGGER co_test_fail BEFORE INSERT ON timesheet_entries FOR EACH ROW EXECUTE FUNCTION co_test_fail_insert()');
        const result = await importEntries([entryRow(), indirectRow({ comment: 'FAIL-ME' })]).catch((e: unknown) => e);
        expect(result instanceof Error || (typeof result === 'object' && result !== null && 'ok' in result && !(result as { ok: boolean }).ok)).toBe(true);
        expect(await entriesOf(employee.id)).toEqual([]);
        expect(await batches()).toEqual([]);
      } finally {
        await raw.unsafe('DROP TRIGGER IF EXISTS co_test_fail ON timesheet_entries');
        await raw.unsafe('DROP FUNCTION IF EXISTS co_test_fail_insert()');
        await raw.end();
      }
    });

    it('a 2,000-row batch succeeds', async () => {
      const others = await Promise.all(Array.from({ length: 9 }, () => createTestUser({ role: 'employee' })));
      const people = [employee, ...others];
      const rows: MigrationEntryRow[] = [];
      for (let i = 0; i < 2000; i++) {
        rows.push(entryRow({ employeeEmail: people[i % 10].email, entryDate: addDays(prevStart(6), -Math.floor(i / 10)) }));
      }
      const r = await expectOk(importEntries(rows));
      expect(r.imported).toBe(2000);
      const [batch] = await batches();
      expect(batch).toMatchObject({ rowCount: 2000, importedCount: 2000 });
    });

    it('MIGRATION is refused by saveTimesheetBatch', async () => {
      const code = await createTestChargeCode(clin.id);
      await getTestDb().insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: code.id, isActive: true });
      await expectFailure(actorStore.run(asFake(employee), () => saveTimesheetBatch({
        periodStart: currentStart(),
        cells: [{ chargeCodeId: code.id, dayIndex: 0, hours: 2, isEdit: false, isLateEntry: true }],
        changeReasonCode: 'MIGRATION',
        comment: 'sneaky',
      })), 'validation', /Invalid change reason code/);
    });

    it('import_batches and admin_change_log: UPDATE / DELETE / TRUNCATE blocked', async () => {
      await expectOk(importEntries([entryRow()]));
      await getTestDb().insert(schema.adminChangeLog).values({ actorId: admin.id, entity: 'test', entityId: admin.id, action: 'noop' });
      const raw = postgres(TEST_DB_URL, { max: 1 });
      try {
        for (const table of ['import_batches', 'admin_change_log']) {
          await expect(raw.unsafe(`UPDATE ${table} SET id = id`)).rejects.toThrow(/append-only/);
          await expect(raw.unsafe(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
          await expect(raw.unsafe(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only/);
        }
      } finally {
        await raw.end();
      }
    });
  });

  // ── Period import ───────────────────────────────────────────────────────────
  describe('period import', () => {
    it('reviewedBy null; events written with source migration + the original reviewer; duplicates skipped (not counted)', async () => {
      const r = await expectOk(importPeriods([periodRow()]));
      expect(r).toMatchObject({ imported: 1, skipped: 0 });
      const [period] = await getTestDb().select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.userId, employee.id));
      expect(period).toMatchObject({ status: 'approved', reviewedBy: null, submittedAt: null, reviewedAt: null, periodNumDays: expect.any(Number) });
      const events = await getTestDb().select().from(schema.periodEvents).where(eq(schema.periodEvents.periodId, period.id));
      expect(events.map((e) => e.event).sort()).toEqual(['approved', 'submitted']);
      for (const e of events) {
        expect(e).toMatchObject({ actorId: admin.id, source: 'migration', importBatchId: r.batchId });
        expect(e.originalMetadata).toEqual({ reviewer: 'boss@oldsystem.example', submittedAt: '2025-01-16T10:00:00Z', reviewedAt: '2025-01-17T10:00:00Z', comment: 'ok' });
      }
      const again = await expectOk(importPeriods([periodRow()]));
      expect(again).toMatchObject({ imported: 0, skipped: 1, batchId: null });
    });

    it('refused where app rows exist (an app period, or app-recorded entries in the period)', async () => {
      await getTestDb().insert(schema.timesheetPeriods).values({ userId: employee.id, periodStart: prevStart(4), status: 'draft' });
      await getTestDb().insert(schema.timesheetEntries).values({ userId: employeeB.id, indirectCodeId: indirect.id, entryDate: addDays(prevStart(6), 2), hours: '8', revisionNumber: 1, createdBy: employeeB.id });
      const r = await expectOk(importPeriods([periodRow(), periodRow({ employeeEmail: employeeB.email, periodStart: prevStart(6) })]));
      expect(r.imported).toBe(0);
      expect(r.errors[0].message).toMatch(/already has this period in CadenzPoint/);
      expect(r.errors[1].message).toMatch(/hours recorded in CadenzPoint in this period/);
    });
  });

  // ── Import race / locks ─────────────────────────────────────────────────────
  describe('import race and lock order', () => {
    it('import batch vs first submitPeriod on separate connections: the batch is fully before the submission, or refused', async () => {
      const code = await createTestChargeCode(clin.id);
      await getTestDb().insert(schema.userChargeCodes).values({ userId: employeeB.id, chargeCodeId: code.id, isActive: true });
      await getTestDb().insert(schema.timesheetEntries).values({ userId: employeeB.id, chargeCodeId: code.id, clinId: clin.id, entryDate: prevStart(1), hours: '8', revisionNumber: 1, createdBy: employeeB.id });
      const [imp, sub] = await Promise.all([
        importEntries([entryRow(), indirectRow()]),
        actorStore.run(asFake(employeeB), () => submitPeriod({ periodStart: prevStart(1) })),
      ]);
      expect(sub.ok).toBe(true);
      if (imp.ok) {
        const rows = await getTestDb().execute(sql`SELECT
          (SELECT max(xmin::text::bigint) FROM import_batches) AS batch_xid,
          (SELECT max(xmin::text::bigint) FROM period_events WHERE event = 'submitted') AS submit_xid`);
        const { batch_xid, submit_xid } = (rows as unknown as Array<{ batch_xid: string; submit_xid: string }>)[0];
        expect(BigInt(batch_xid)).toBeLessThan(BigInt(submit_xid)); // committed BEFORE the submission
        expect((await entriesOf(employee.id))).toHaveLength(2);
      } else {
        expect(imp.error).toMatch(WINDOW_REFUSED);
        expect(await entriesOf(employee.id)).toEqual([]);
        expect(await batches()).toEqual([]);
      }
    });

    it('lock order: a concurrent import (employees A, B) and submits by A and B never deadlock (5 rounds)', async () => {
      for (let round = 0; round < 5; round++) {
        await cleanupTestData();
        admin = await createTestUser({ role: 'admin' });
        employee = await createTestUser({ role: 'employee' });
        employeeB = await createTestUser({ role: 'employee' });
        contract = await createTestContract();
        clin = await createTestClin(contract.id);
        indirect = await createTestIndirectCode();
        const cc = await createTestChargeCode(clin.id);
        for (const u of [employee, employeeB]) {
          await getTestDb().insert(schema.userChargeCodes).values({ userId: u.id, chargeCodeId: cc.id, isActive: true });
          await getTestDb().insert(schema.timesheetEntries).values({ userId: u.id, chargeCodeId: cc.id, clinId: clin.id, entryDate: prevStart(1), hours: '8', revisionNumber: 1, createdBy: u.id });
        }
        // Every call must RESOLVE (an ActionResult); a deadlock (40P01) would reject one of them.
        const results = await Promise.all([
          importEntries([entryRow(), entryRow({ employeeEmail: employeeB.email })]),
          actorStore.run(asFake(employee), () => submitPeriod({ periodStart: prevStart(1) })),
          actorStore.run(asFake(employeeB), () => submitPeriod({ periodStart: prevStart(1) })),
        ]);
        expect(results[1].ok && results[2].ok, `round ${round}: ${JSON.stringify(results)}`).toBe(true);
        expect(results[0].ok || /can only be imported before/.test((results[0] as { error: string }).error)).toBe(true);
      }
    });
  });

  // ── Display: v1 API ─────────────────────────────────────────────────────────
  it('v1 API returns source / importedFrom for entries and approvedBy null + approvalSource migration for imported approvals', async () => {
    const r = await expectOk(importEntries([entryRow({ entryDate: addDays(prevStart(6), 1) })]));
    await expectOk(importPeriods([periodRow()]));
    const rawKey = `byt_${crypto.randomBytes(24).toString('hex')}`;
    await getTestDb().insert(schema.apiKeys).values({
      name: 'Test key', keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'), keyPrefix: rawKey.substring(0, 8),
      createdByUserId: admin.id, permissions: 'read', isActive: true,
    });
    const headers = { Authorization: `Bearer ${rawKey}`, 'x-forwarded-for': '203.0.113.41' };
    const from = prevStart(8);
    const entries = await (await getV1Timesheets(new Request(`http://localhost:3000/api/v1/timesheets?startDate=${from}&endDate=${today()}`, { headers }) as never)).json();
    const [entry] = entries.data.filter((e: { userId: string }) => e.userId === employee.id);
    expect(entry).toMatchObject({ source: 'migration', importedFrom: 'LegacyTime' });
    expect(entry.importedAt).toBeTruthy();
    const periods = await (await getV1Periods(new Request(`http://localhost:3000/api/v1/periods?startDate=${from}`, { headers }) as never)).json();
    const [period] = periods.data.filter((p: { userId: string }) => p.userId === employee.id);
    expect(period).toMatchObject({ status: 'approved', approvedBy: null, approvalSource: 'migration' });
    expect(r.batchId).toBeTruthy();
  });
});
