import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { diffDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  createTestIndirectCode,
  cleanupTestData,
  expectOk,
  expectFailure,
} from './helpers';

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
import {
  assignChargeCodeToUser,
  unassignChargeCodeFromUser,
  deactivateChargeCode,
  autobridgeChargeCodesFromClins,
} from '@/server/actions/charge-codes';
import {
  saveTimesheetBatch,
  getChargeCodesForUser,
  getTimesheetEntries,
  getRevisionMap,
} from '@/server/actions/timesheet';
import { getSupervisedEmployeeIds } from '@/server/internal/supervisor-scope';

function actingAs(user: { id: string; role: string; email: string; fullName: string }) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Charge-code server actions — real end-to-end behavior', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let employee: Awaited<ReturnType<typeof createTestUser>>;
  let contract: Awaited<ReturnType<typeof createTestContract>>;
  let clin: Awaited<ReturnType<typeof createTestClin>>;
  let chargeCode: Awaited<ReturnType<typeof createTestChargeCode>>;
  let periodStart: CalendarDate;
  let todayIndex: number;

  beforeEach(async () => {
    await cleanupTestData();

    admin = await createTestUser({ role: 'admin' });
    employee = await createTestUser({ role: 'employee' });
    contract = await createTestContract();
    clin = await createTestClin(contract.id);
    chargeCode = await createTestChargeCode(clin.id);

    actingAs(admin);

    // workspace_settings seeds 'America/New_York' by default (migration 0011); this suite never
    // changes it, so fixtures compute "today" the same way the real actions do.
    periodStart = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    todayIndex = diffDays(periodStart, todayIn('America/New_York'));
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  // -------------------------------------------------------------------------
  it('denormalizes clinId/slinId onto the entry when saving by chargeCodeId', async () => {
    await assignChargeCodeToUser(employee.id, chargeCode.id);

    actingAs(employee);
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 8, isEdit: false, isLateEntry: false }],
    }));

    const db = getTestDb();
    const [row] = await db.select().from(schema.timesheetEntries)
      .where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id));

    expect(row.chargeCodeId).toBe(chargeCode.id);
    expect(row.clinId).toBe(clin.id);
    expect(row.slinId).toBe(chargeCode.slinId);
  });

  // -------------------------------------------------------------------------
  it('is append-only: editing a cell inserts revision 2 and leaves revision 1 untouched', async () => {
    await assignChargeCodeToUser(employee.id, chargeCode.id);

    actingAs(employee);
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 8, isEdit: false, isLateEntry: false }],
    }));

    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 6, isEdit: true, isLateEntry: false }],
      changeReasonCode: 'CORRECTION',
      comment: 'Fixed hours',
    }));

    const db = getTestDb();
    const rows = await db.select().from(schema.timesheetEntries)
      .where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id))
      .orderBy(schema.timesheetEntries.revisionNumber);

    expect(rows).toHaveLength(2);
    expect(rows[0].revisionNumber).toBe(1);
    expect(rows[0].hours).toBe('8');
    expect(rows[1].revisionNumber).toBe(2);
    expect(rows[1].hours).toBe('6');
    expect(rows[1].changeReasonCode).toBe('CORRECTION');
  });

  // -------------------------------------------------------------------------
  it('rejects an edit with no reason code', async () => {
    await assignChargeCodeToUser(employee.id, chargeCode.id);

    actingAs(employee);
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 8, isEdit: false, isLateEntry: false }],
    }));

    await expectFailure(saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 6, isEdit: true, isLateEntry: false }],
      }), 'validation', /reason code/i);
  });

  // -------------------------------------------------------------------------
  it('tracks two charge codes on the same CLIN, same day, independently', async () => {
    const otherCode = await createTestChargeCode(clin.id, { workLocation: 'telework' });
    await assignChargeCodeToUser(employee.id, chargeCode.id);
    await assignChargeCodeToUser(employee.id, otherCode.id);

    actingAs(employee);
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [
        { chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 5, isEdit: false, isLateEntry: false },
        { chargeCodeId: otherCode.id, dayIndex: todayIndex, hours: 3, isEdit: false, isLateEntry: false },
      ],
    }));

    const codes = await getChargeCodesForUser();
    const entries = await getTimesheetEntries(periodStart, codes);

    const forFirst = entries.find((e) => e.chargeCodeId === chargeCode.id);
    const forSecond = entries.find((e) => e.chargeCodeId === otherCode.id);
    expect(forFirst?.hours[todayIndex]).toBe(5);
    expect(forSecond?.hours[todayIndex]).toBe(3);
  });

  // -------------------------------------------------------------------------
  it('enforces RBAC: unassigned user cannot save, and re-saving after unassignment fails again', async () => {
    actingAs(employee);
    await expectFailure(saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 8, isEdit: false, isLateEntry: false }],
      }), 'forbidden', /Unauthorized/);

    actingAs(admin);
    await assignChargeCodeToUser(employee.id, chargeCode.id);

    actingAs(employee);
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 8, isEdit: false, isLateEntry: false }],
    }));

    actingAs(admin);
    await unassignChargeCodeFromUser(employee.id, chargeCode.id);

    actingAs(employee);
    await expectFailure(saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex - 1, hours: 4, isEdit: false, isLateEntry: false }],
      }), 'forbidden', /Unauthorized/);
  });

  // -------------------------------------------------------------------------
  it('assignChargeCodeToUser syncs an active user_assignments row, idempotently, and re-activates it', async () => {
    const db = getTestDb();

    await assignChargeCodeToUser(employee.id, chargeCode.id);
    let [assignment] = await db.select().from(schema.userAssignments)
      .where(and(eq(schema.userAssignments.userId, employee.id), eq(schema.userAssignments.clinId, clin.id)));
    expect(assignment).toBeDefined();
    expect(assignment.isActive).toBe(true);

    // Idempotent — calling again doesn't create a second row.
    await assignChargeCodeToUser(employee.id, chargeCode.id);
    const rows = await db.select().from(schema.userAssignments)
      .where(and(eq(schema.userAssignments.userId, employee.id), eq(schema.userAssignments.clinId, clin.id)));
    expect(rows).toHaveLength(1);

    // Re-activates a previously deactivated assignment.
    await db.update(schema.userAssignments).set({ isActive: false }).where(eq(schema.userAssignments.id, assignment.id));
    await assignChargeCodeToUser(employee.id, chargeCode.id);
    [assignment] = await db.select().from(schema.userAssignments)
      .where(and(eq(schema.userAssignments.userId, employee.id), eq(schema.userAssignments.clinId, clin.id)));
    expect(assignment.isActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  it('supervisor scope includes an employee charging a code under the supervisor\'s CLIN', async () => {
    const supervisor = await createTestUser({ role: 'supervisor' });
    const db = getTestDb();
    await db.insert(schema.userAssignments).values({ userId: supervisor.id, clinId: clin.id, isActive: true });

    await assignChargeCodeToUser(employee.id, chargeCode.id);

    const supervised = await getSupervisedEmployeeIds(supervisor.id, 'supervisor');
    expect(supervised).toContain(employee.id);
  });

  // -------------------------------------------------------------------------
  it('blocks any save once the period has been submitted', async () => {
    await assignChargeCodeToUser(employee.id, chargeCode.id);
    const db = getTestDb();
    await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart,
      status: 'submitted',
      submittedAt: new Date(),
    });

    actingAs(employee);
    await expectFailure(saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 8, isEdit: false, isLateEntry: false }],
      }), 'validation', /certified and is locked/i);
  });

  // -------------------------------------------------------------------------
  it('rejects a save for a future date', async () => {
    await assignChargeCodeToUser(employee.id, chargeCode.id);

    actingAs(employee);
    await expectFailure(saveTimesheetBatch({
        periodStart,
        cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex + 1, hours: 8, isEdit: false, isLateEntry: false }],
      }), 'validation', /future date/i);
  });

  // -------------------------------------------------------------------------
  it('leaves the indirect-code path unchanged: indirectCodeId set, chargeCodeId null', async () => {
    const indirect = await createTestIndirectCode();

    actingAs(employee);
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ indirectCodeId: indirect.id, dayIndex: todayIndex, hours: 2, isEdit: false, isLateEntry: false }],
    }));

    const db = getTestDb();
    const [row] = await db.select().from(schema.timesheetEntries)
      .where(eq(schema.timesheetEntries.indirectCodeId, indirect.id));
    expect(row.chargeCodeId).toBeNull();
    expect(row.indirectCodeId).toBe(indirect.id);
    expect(row.hours).toBe('2');
  });

  // -------------------------------------------------------------------------
  it('getRevisionMap keys direct cells by chargeCodeId', async () => {
    await assignChargeCodeToUser(employee.id, chargeCode.id);

    actingAs(employee);
    await expectOk(saveTimesheetBatch({
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 8, isEdit: false, isLateEntry: false }],
    }));

    // Wide enough to cover todayIndex regardless of period type/length (max is 16 days,
    // semimonthly) or where in the period "today" falls when the suite runs.
    const numDays = 31;
    const map = await getRevisionMap(periodStart);
    expect(map[`${chargeCode.id}-${todayIndex}`]).toBe(1);
  });

  // -------------------------------------------------------------------------
  it('autobridgeChargeCodesFromClins creates one code per bare active CLIN and is idempotent', async () => {
    const bareClin = await createTestClin(contract.id);

    const first = await autobridgeChargeCodesFromClins();
    expect(first.created).toBeGreaterThanOrEqual(1);

    const db = getTestDb();
    const codesForBareClin = await db.select().from(schema.chargeCodes).where(eq(schema.chargeCodes.clinId, bareClin.id));
    expect(codesForBareClin).toHaveLength(1);

    const second = await autobridgeChargeCodesFromClins();
    expect(second.created).toBe(0);

    const codesForBareClinAfter = await db.select().from(schema.chargeCodes).where(eq(schema.chargeCodes.clinId, bareClin.id));
    expect(codesForBareClinAfter).toHaveLength(1);
  });

  it('deactivateChargeCode soft-deletes: the row remains but drops out of getChargeCodesForUser', async () => {
    await assignChargeCodeToUser(employee.id, chargeCode.id);

    actingAs(employee);
    const before = await getChargeCodesForUser();
    expect(before.some((c) => c.id === chargeCode.id)).toBe(true);

    actingAs(admin);
    await deactivateChargeCode(chargeCode.id);

    const db = getTestDb();
    const [row] = await db.select().from(schema.chargeCodes).where(eq(schema.chargeCodes.id, chargeCode.id));
    expect(row).toBeDefined();
    expect(row.isActive).toBe(false);

    actingAs(employee);
    const after = await getChargeCodesForUser();
    expect(after.some((c) => c.id === chargeCode.id)).toBe(false);
  });
});
