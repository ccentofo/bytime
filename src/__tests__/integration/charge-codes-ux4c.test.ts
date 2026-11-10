import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-ux-people-codes.md §3.2–§3.4: CC-4 (peopleCount and chargeable), CC-6 (Create codes from CLINs), CC-7
 * (create / update checks), AS-3 (assignChargeCodesToUser) and AS-8 (assignUserToClin), against Postgres.
 */

// ---------------------------------------------------------------------------
// Harness: mock only the I/O edges (tenant DB resolution, the Auth.js session).
// @/lib/session is NOT mocked — the real guards (requireSession/requireAdmin/
// assertCanAccessEmployee) run for real against the mocked @/auth session, so a
// regression in who's allowed to do what shows up here instead of being hidden.
// ---------------------------------------------------------------------------

// UX-4C1-AUDIT.md M5: a code string taken AFTER autobridge's qualifying check and before its insert (a concurrent
// create). The test pool has one connection, so the "other writer" runs on the transaction itself, just before the
// charge_codes insert executes: the insert's ON CONFLICT DO NOTHING is what keeps it from failing.
const race = vi.hoisted(() => ({ beforeChargeCodeInsert: null as null | ((tx: ReturnType<typeof getTestDb>) => Promise<void>) }));
type AnyFn = (...a: unknown[]) => unknown;
/** A builder chain recorded until awaited, so the async hook runs first; then the chain is replayed on the real builder. */
function deferred(start: () => unknown, hook: () => Promise<void>): unknown {
  const calls: Array<[PropertyKey, unknown[]]> = [];
  const chain: unknown = new Proxy({}, {
    get: (_t, k) => (k === 'then'
      ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        hook().then(() => calls.reduce((b, [m, a]) => ((b as Record<PropertyKey, AnyFn>)[m] as AnyFn).apply(b, a), start())).then(res, rej)
      : (...a: unknown[]) => { calls.push([k, a]); return chain; }),
  });
  return chain;
}
const bound = (t: object, k: PropertyKey) => { const v = Reflect.get(t, k); return typeof v === 'function' ? (v as AnyFn).bind(t) : v; };
function racing(db: ReturnType<typeof getTestDb>) {
  return new Proxy(db, {
    get: (t, k) => (k !== 'transaction' ? bound(t, k) : (cb: (tx: unknown) => unknown, ...rest: unknown[]) =>
      (t.transaction as AnyFn).call(t, (tx: ReturnType<typeof getTestDb>) => cb(new Proxy(tx, {
        get: (tt, kk) => (kk !== 'insert' ? bound(tt, kk) : (table: unknown) => {
          const hook = race.beforeChargeCodeInsert;
          if (table !== schema.chargeCodes || !hook) return tt.insert(table as typeof schema.chargeCodes);
          race.beforeChargeCodeInsert = null;
          return deferred(() => tt.insert(table as typeof schema.chargeCodes), () => hook(tt));
        }),
      })), ...rest)),
  });
}

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => racing(getTestDb()),
  // requireAdminFresh (feature-plan-launch-blockers.md P3) re-reads the role through getDbForAuth.
  getDbForAuth: async () => getTestDb(),
}));

// R2-1: getSessionUser() now checks session.user.tenantSlug against the request's tenant
// (getTenantSlug()). Keep them matching here so existing tests exercise authorization, not
// the tenant-binding check — that check gets its own dedicated test files.
const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
}));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };

const sessionState = vi.hoisted(() => ({
  user: null as null | FakeSessionUser,
}));

vi.mock('@/auth', () => ({
  auth: async () =>
    sessionState.user
      ? {
          user: {
            id: sessionState.user.id,
            email: sessionState.user.email,
            fullName: sessionState.user.fullName,
            role: sessionState.user.role,
            tenantSlug: tenantState.requestSlug,
          },
        }
      : null,
}));

// No outbound email. List every export explicitly — do NOT use a catch-all Proxy here: a Proxy
// that returns a function for every key also answers `then`, so vitest's `await factory()` treats
// the mock as a never-resolving thenable and the whole run hangs during module loading.
vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendDailyReminderEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendSubmissionDeadlineEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendPasswordResetEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
}));

// Imports AFTER the mocks — vitest hoists vi.mock, so this is safe at module top level.
import { assignChargeCodesToUser, autobridgeChargeCodesFromClins, createChargeCode, listChargeCodes, previewAutobridgeChargeCodes, updateChargeCode } from '@/server/actions/charge-codes';
import { assignUserToClin } from '@/server/actions/assignments';
import { and } from 'drizzle-orm';

function actingAs(user: { id: string; role: string; email: string; fullName: string }) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Charge codes (UX-4c §3)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  beforeEach(async () => { await cleanupTestData(); admin = await createTestUser({ role: 'admin' }); actingAs(admin); });
  afterEach(async () => { sessionState.user = null; race.beforeChargeCodeInsert = null; await cleanupTestData(); });

  it('CC-4: peopleCount counts active rows of active users only; chargeable is false on an inactive CLIN', async () => {
    const db = getTestDb();
    const contract = await createTestContract();
    const live = await createTestClin(contract.id);
    const closed = await createTestClin(contract.id, { status: 'inactive' });
    const code = await createTestChargeCode(live.id);
    const dead = await createTestChargeCode(closed.id);
    const [a, b, c] = [await createTestUser(), await createTestUser(), await createTestUser({ isActive: false })];
    await db.insert(schema.userChargeCodes).values([
      { userId: a.id, chargeCodeId: code.id, isActive: true },
      { userId: b.id, chargeCodeId: code.id, isActive: false },            // inactive row
      { userId: c.id, chargeCodeId: code.id, isActive: true },             // inactive user
      { userId: a.id, chargeCodeId: dead.id, isActive: true },
    ]);
    const rows = await listChargeCodes();
    const of = (id: string) => rows.find((r) => r.id === id)!;
    expect([of(code.id).peopleCount, of(code.id).chargeable]).toEqual([1, true]);
    expect([of(dead.id).peopleCount, of(dead.id).chargeable]).toEqual([1, false]);
  });

  it('CC-6: preview marks a taken and a too-long code; a subset creates only those; [] refused; no argument creates the whole available set; created counts inserted rows', async () => {
    const db = getTestDb();
    const contract = await createTestContract({ contractNumber: `K${Date.now()}`, name: 'Alpha' });
    const [c1, c2, c3] = [await createTestClin(contract.id, { clinNumber: '0001' }), await createTestClin(contract.id, { clinNumber: '0002' }), await createTestClin(contract.id, { clinNumber: '0003' })];
    const taken = await createTestClin(contract.id, { clinNumber: '0004' });
    const elsewhere = await createTestClin((await createTestContract()).id);
    await createTestChargeCode(elsewhere.id, { code: `${contract.contractNumber}-0004` });   // the string CLIN 0004 would get
    // The longest code the columns allow: varchar(50) contract number + '-' + varchar(50) CLIN number = 101 > 100.
    const longContract = await createTestContract({ contractNumber: 'L'.repeat(50), name: 'Long' });
    const long = await createTestClin(longContract.id, { clinNumber: 'C'.repeat(50) });

    const preview = await previewAutobridgeChargeCodes();
    const p = (id: string) => preview.find((r) => r.clinId === id)!;
    expect(p(taken.id)).toMatchObject({ available: false, reason: `Code ${contract.contractNumber}-0004 is already used — add one yourself.` });
    expect(p(long.id)).toMatchObject({ available: false, reason: 'Code would be too long — add one yourself.' });
    expect([p(c1.id).available, p(c2.id).available, p(c3.id).available]).toEqual([true, true, true]);

    expect(await expectOk(autobridgeChargeCodesFromClins([c1.id, taken.id]))).toEqual({ created: 1, skipped: 1 });
    const codesOn = async (clinId: string) => db.select().from(schema.chargeCodes).where(eq(schema.chargeCodes.clinId, clinId));
    expect(await codesOn(c1.id)).toHaveLength(1);
    expect(await codesOn(c2.id)).toHaveLength(0);
    expect(await codesOn(taken.id)).toHaveLength(0);
    await expectFailure(autobridgeChargeCodesFromClins([]), 'validation', /^Tick at least one CLIN\.$/);

    expect(await expectOk(autobridgeChargeCodesFromClins())).toEqual({ created: 2, skipped: 0 });   // c2, c3 (not taken, not long)
    expect(await codesOn(c3.id)).toHaveLength(1);
    expect(await codesOn(long.id)).toHaveLength(0);
    expect(await expectOk(autobridgeChargeCodesFromClins())).toEqual({ created: 0, skipped: 0 });
  });

  it('M5: a code string taken after the qualifying check (a concurrent create) is skipped, not an error → { created: 0, skipped: 1 }', async () => {
    const db = getTestDb();
    const contract = await createTestContract({ contractNumber: `R${Date.now()}` });
    const target = await createTestClin(contract.id, { clinNumber: '0001' });
    const elsewhere = await createTestClin((await createTestContract()).id);
    expect((await previewAutobridgeChargeCodes()).find((r) => r.clinId === target.id)).toMatchObject({ available: true });
    race.beforeChargeCodeInsert = async (tx) => {
      await tx.insert(schema.chargeCodes).values({ code: `${contract.contractNumber}-0001`, name: 'Concurrent', clinId: elsewhere.id });
    };
    expect(await expectOk(autobridgeChargeCodesFromClins([target.id]))).toEqual({ created: 0, skipped: 1 });
    expect(race.beforeChargeCodeInsert).toBeNull();                                         // the concurrent insert ran
    expect(await db.select().from(schema.chargeCodes).where(eq(schema.chargeCodes.clinId, target.id))).toHaveLength(0);
    expect(await db.select().from(schema.chargeCodes).where(eq(schema.chargeCodes.clinId, elsewhere.id))).toHaveLength(1);
  });

  it('CC-7: create refuses a SLIN from another CLIN and an inactive CLIN; an update moving the CLIN while the old SLIN stays is refused', async () => {
    const db = getTestDb();
    const contract = await createTestContract();
    const [c1, c2] = [await createTestClin(contract.id), await createTestClin(contract.id)];
    const closed = await createTestClin(contract.id, { status: 'inactive' });
    const [s2] = await db.insert(schema.slins).values({ clinId: c2.id, slinNumber: '0002AA' }).returning();
    const [s1] = await db.insert(schema.slins).values({ clinId: c1.id, slinNumber: '0001AA' }).returning();
    await expectFailure(createChargeCode({ code: 'X1', name: 'X', clinId: c1.id, slinId: s2.id }), 'validation', /^That SLIN isn't on the chosen CLIN\.$/);
    await expectFailure(createChargeCode({ code: 'X2', name: 'X', clinId: closed.id }), 'validation', /^Choose an active CLIN\.$/);
    const made = await expectOk(createChargeCode({ code: '  X3  ', name: 'X', clinId: c1.id, slinId: s1.id }));
    expect(made.code).toBe('X3');
    await expectFailure(updateChargeCode(made.id, { clinId: c2.id }), 'validation', /^That SLIN isn't on the chosen CLIN\.$/);
    await expectOk(updateChargeCode(made.id, { clinId: c2.id, slinId: s2.id }));
    const [row] = await db.select().from(schema.chargeCodes).where(eq(schema.chargeCodes.id, made.id));
    expect([row.clinId, row.slinId]).toEqual([c2.id, s2.id]);
  });

  it('AS-3: an inactive person refused; one non-chargeable code → nothing written; an inactive row reactivated; assigned excludes held', async () => {
    const db = getTestDb();
    const contract = await createTestContract();
    const live = await createTestClin(contract.id);
    const closed = await createTestClin(contract.id, { status: 'inactive' });
    const [a, b, held] = [await createTestChargeCode(live.id), await createTestChargeCode(live.id), await createTestChargeCode(live.id)];
    const dead = await createTestChargeCode(closed.id);
    const person = await createTestUser();
    const gone = await createTestUser({ isActive: false });
    await expectFailure(assignChargeCodesToUser({ userId: gone.id, chargeCodeIds: [a.id] }), 'validation', /^Choose an active person\.$/);
    await expectFailure(assignChargeCodesToUser({ userId: person.id, chargeCodeIds: [a.id, dead.id] }), 'validation', new RegExp(`^${dead.code} can't be charged right now\\.`));
    const rowsFor = () => db.select().from(schema.userChargeCodes).where(eq(schema.userChargeCodes.userId, person.id));
    expect(await rowsFor()).toHaveLength(0);
    await db.insert(schema.userChargeCodes).values([
      { userId: person.id, chargeCodeId: held.id, isActive: true, assignedBy: admin.id },
      { userId: person.id, chargeCodeId: b.id, isActive: false },
    ]);
    expect(await expectOk(assignChargeCodesToUser({ userId: person.id, chargeCodeIds: [a.id, b.id, held.id] }))).toEqual({ assigned: 2 });
    const rows = await rowsFor();
    expect(rows.every((r) => r.isActive)).toBe(true);
    expect(rows.find((r) => r.chargeCodeId === b.id)!.isActive).toBe(true);           // reactivated
    const [clinRow] = await db.select().from(schema.userAssignments).where(and(eq(schema.userAssignments.userId, person.id), eq(schema.userAssignments.clinId, live.id)));
    expect(clinRow.isActive).toBe(true);
  });

  it('AS-8: assignUserToClin refuses an inactive person and a non-supervisor', async () => {
    const clin = await createTestClin((await createTestContract()).id);
    const off = await createTestUser({ role: 'supervisor', isActive: false });
    const emp = await createTestUser({ role: 'employee' });
    const sup = await createTestUser({ role: 'supervisor' });
    await expectFailure(assignUserToClin({ userId: off.id, clinId: clin.id }), 'validation', /^Choose an active supervisor\.$/);
    await expectFailure(assignUserToClin({ userId: emp.id, clinId: clin.id }), 'validation', /^Choose an active supervisor\.$/);
    const row = await expectOk(assignUserToClin({ userId: sup.id, clinId: clin.id }));
    expect([row.isActive, row.slinId]).toEqual([true, null]);
  });
});
