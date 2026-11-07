import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-ux-people-codes.md §3.2–§3.4: CC-4 (peopleCount and chargeable), CC-6 (Create codes from CLINs), CC-7
 * (create / update checks), against Postgres.
 */

// ---------------------------------------------------------------------------
// Harness: mock only the I/O edges (tenant DB resolution, the Auth.js session).
// @/lib/session is NOT mocked — the real guards (requireSession/requireAdmin/
// assertCanAccessEmployee) run for real against the mocked @/auth session, so a
// regression in who's allowed to do what shows up here instead of being hidden.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
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
import { autobridgeChargeCodesFromClins, createChargeCode, listChargeCodes, previewAutobridgeChargeCodes, updateChargeCode } from '@/server/actions/charge-codes';

function actingAs(user: { id: string; role: string; email: string; fullName: string }) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Charge codes (UX-4c §3)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  beforeEach(async () => { await cleanupTestData(); admin = await createTestUser({ role: 'admin' }); actingAs(admin); });
  afterEach(async () => { sessionState.user = null; await cleanupTestData(); });

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
    const longContract = await createTestContract({ contractNumber: 'L'.repeat(97), name: 'Long' });
    const long = await createTestClin(longContract.id, { clinNumber: '0001' });

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
});
