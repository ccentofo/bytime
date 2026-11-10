'use server';

import { getDb, getDbForWrite } from '@/db';
import { chargeCodes, chargeCodeLaborCategories, costClasses, userChargeCodes, clins, contracts, slins, laborCategories, users, timesheetEntries } from '@/db/schema';
import { eq, and, inArray, isNull, sql } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { UserFacingError } from '@/lib/errors';
import {
  assignChargeCodeToUserInternal,
  createChargeCodeInternal,
  createCostClassInternal,
  type ChargeCodeInput,
} from '@/server/internal/charge-codes';
import { userAction, type ActionResult } from '@/lib/action-result';
import { logAdminChange } from '@/server/internal/admin-change-log';
import type { CategoryChange } from '@/lib/labor-rates';
import type { CalendarDate } from '@/lib/calendar-date';
import { CHARGEABLE_CODE } from '@/server/internal/chargeable';
import { validateOptionalString, validateUUID } from '@/lib/validation';
import type { TenantWriter, ReadDb } from '@/db';

// ---------------------------------------------------------------------------
// Cost Classes
// ---------------------------------------------------------------------------

export async function listCostClasses() {
  await requireAdmin();
  const db = await getDb();
  return db.select().from(costClasses).where(eq(costClasses.isActive, true)).orderBy(costClasses.name);
}

export async function createCostClass(name: string) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    return createCostClassInternal(db, name);
  });
}

// ---------------------------------------------------------------------------
// Charge Codes CRUD
// ---------------------------------------------------------------------------

export async function listChargeCodes() {
  await requireAdmin();
  const db = await getDb();
  const rows = await db
    .select({
      id: chargeCodes.id,
      code: chargeCodes.code,
      name: chargeCodes.name,
      description: chargeCodes.description,
      clinId: chargeCodes.clinId,
      clinNumber: clins.clinNumber,
      // feature-plan-ux-people-codes.md §3.2: the CLIN's description, the SLIN's number, whether the code takes new hours.
      clinDescription: clins.description,
      slinId: chargeCodes.slinId,
      slinNumber: slins.slinNumber,
      chargeable: sql<boolean>`${CHARGEABLE_CODE}`.mapWith(Boolean),
      contractId: clins.contractId,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      laborCategoryId: chargeCodes.laborCategoryId,
      classId: chargeCodes.classId,
      className: costClasses.name,
      workLocation: chargeCodes.workLocation,
      billable: chargeCodes.billable,
      isActive: chargeCodes.isActive,
      createdAt: chargeCodes.createdAt,
      // feature-plan-ux-page-fixes.md C5: a code with recorded hours can't change CLIN (the server refuses it), so the
      // edit form shows its CLIN read-only. The outer column is written LITERALLY (charge_codes.id): an interpolated
      // ${chargeCodes.id} renders unqualified in a single-table select and would bind to te.id (UX-3 lesson).
      hasHours: sql<boolean>`exists(select 1 from timesheet_entries te where te.charge_code_id = charge_codes.id)`,
      // §3.2: People = active access rows whose user is active. The outer column is literal (charge_codes.id), as above.
      peopleCount: sql<number>`(select count(*) from user_charge_codes ucc join users u on u.id = ucc.user_id where ucc.charge_code_id = charge_codes.id and ucc.is_active and u.is_active)`.mapWith(Number),
    })
    .from(chargeCodes)
    .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
    .leftJoin(costClasses, eq(chargeCodes.classId, costClasses.id))
    .orderBy(contracts.name, clins.clinNumber, chargeCodes.code);
  // Dated rates D3: each code's dated labor-category changes (laborCategoryId above is the STARTING category).
  const changes = rows.length === 0 ? [] : await db
    .select({ id: chargeCodeLaborCategories.id, chargeCodeId: chargeCodeLaborCategories.chargeCodeId, effectiveDate: chargeCodeLaborCategories.effectiveDate, laborCategoryId: chargeCodeLaborCategories.laborCategoryId })
    .from(chargeCodeLaborCategories)
    .where(inArray(chargeCodeLaborCategories.chargeCodeId, rows.map((r) => r.id)));
  const byCode = new Map<string, CategoryChange[]>();
  for (const c of changes) {
    const list = byCode.get(c.chargeCodeId) ?? [];
    list.push({ id: c.id, effectiveDate: c.effectiveDate as CalendarDate, laborCategoryId: c.laborCategoryId });
    byCode.set(c.chargeCodeId, list);
  }
  return rows.map((r) => ({ ...r, categoryChanges: byCode.get(r.id) ?? [] }));
}

// ── Validation (feature-plan-ux-people-codes.md §3.4): in the actions, not createChargeCodeInternal, so the QBO import
// keeps its own rules. ─────────────────────────────────────────────────────────────────────────────────────────────

function validCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code) throw new UserFacingError('Enter a code.');
  if (code.length > 100) throw new UserFacingError('The code must be 100 characters or fewer.');
  return code;
}
function validName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new UserFacingError('Enter a name.');
  if (name.length > 255) throw new UserFacingError('The name must be 255 characters or fewer.');
  return name;
}
const optionalUuid = (value: unknown, field: string) => (value === undefined || value === null || value === '' ? undefined : validateUUID(value, field));

/** The SLIN (if any) must sit on the CLIN — checked on the EFFECTIVE pair, after an update is merged. */
async function assertSlinOnClin(tx: TenantWriter, clinId: string, slinId: string | null | undefined) {
  if (!slinId) return;
  const [slin] = await tx.select({ clinId: slins.clinId }).from(slins).where(eq(slins.id, slinId));
  if (!slin || slin.clinId !== clinId) throw new UserFacingError("That SLIN isn't on the chosen CLIN.");
}

export async function createChargeCode(data: ChargeCodeInput) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    if (!data?.clinId) throw new UserFacingError('Choose a CLIN.');
    const clinId = validateUUID(data.clinId, 'CLIN');
    const input: ChargeCodeInput = {
      code: validCode(data.code),
      name: validName(data.name),
      description: validateOptionalString(data.description, 'Description', 2000),
      clinId,
      slinId: optionalUuid(data.slinId, 'SLIN'),
      laborCategoryId: optionalUuid(data.laborCategoryId, 'Labor category'),
      classId: optionalUuid(data.classId, 'Class'),
      workLocation: data.workLocation,
      billable: data.billable,
    };
    return db.transaction(async (tx) => {
      // A new code goes on an active CLIN of an active contract.
      const [clin] = await tx.select({ clinStatus: clins.status, contractStatus: contracts.status })
        .from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id)).where(eq(clins.id, clinId));
      if (!clin || clin.clinStatus !== 'active' || clin.contractStatus !== 'active') throw new UserFacingError('Choose an active CLIN.');
      await assertSlinOnClin(tx, clinId, input.slinId);
      return createChargeCodeInternal(tx, input);
    });
  });
}

export async function updateChargeCode(id: string, data: {
  code?: string;
  name?: string;
  description?: string;
  clinId?: string;
  slinId?: string | null;
  classId?: string | null;
  workLocation?: 'onsite' | 'telework' | 'other' | null;
  billable?: boolean;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    // R2-6: explicit allowlist — never spread the caller's object into .set(). `isActive` in
    // particular is a real column not in this form's type; deactivation has its own action
    // (deactivateChargeCode) and must not be settable through this one.
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    // feature-plan-ux-people-codes.md §3.4: the same field rules as create (the code is trimmed here too).
    if (data.code !== undefined) updateData.code = validCode(data.code);
    if (data.name !== undefined) updateData.name = validName(data.name);
    if (data.description !== undefined) updateData.description = validateOptionalString(data.description, 'Description', 2000) ?? null;
    if (data.clinId !== undefined) updateData.clinId = validateUUID(data.clinId, 'CLIN');
    if (data.slinId !== undefined) updateData.slinId = optionalUuid(data.slinId, 'SLIN') ?? null;
    if (data.classId !== undefined) updateData.classId = optionalUuid(data.classId, 'Class') ?? null;
    if (data.workLocation !== undefined) updateData.workLocation = data.workLocation;
    if (data.billable !== undefined) updateData.billable = data.billable;

    // feature-plan-certified-outputs.md C3 (charge-code denormalization invariant): compared against the stored row,
    // locked FOR UPDATE (saveTimesheetBatch re-reads FOR SHARE, so the two serialize). A used code's CLIN/SLIN never
    // changes. The labor category is NOT editable here (feature-plan-dated-rates.md D3): it changes only through the
    // dated category actions (src/server/actions/charge-code-categories.ts), which log every change.
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(chargeCodes).where(eq(chargeCodes.id, id)).for('update');
      if (!current) throw new UserFacingError('Charge code not found.', 'not_found');
      const clinChanged = data.clinId !== undefined && data.clinId !== current.clinId;
      const slinChanged = data.slinId !== undefined && (data.slinId ?? null) !== current.slinId;
      const used = clinChanged || slinChanged
        ? (await tx.select({ id: timesheetEntries.id }).from(timesheetEntries).where(eq(timesheetEntries.chargeCodeId, id)).limit(1)).length > 0
        : false;
      if (used && (clinChanged || slinChanged)) {
        throw new UserFacingError('This charge code already has recorded hours, so its CLIN and SLIN can\'t change — the hours stay on the CLIN they were recorded against. Create a new charge code instead.');
      }
      if (clinChanged || slinChanged) {
        // DR-Q2 default: a code's categories must sit on its own CLIN/SLIN, so it can't move while it has any.
        const [dated] = await tx.select({ id: chargeCodeLaborCategories.id }).from(chargeCodeLaborCategories).where(eq(chargeCodeLaborCategories.chargeCodeId, id)).limit(1);
        if (current.laborCategoryId || dated) {
          throw new UserFacingError("Remove this charge code's labor categories before moving it to another CLIN or SLIN.");
        }
      }
      // §3.4: after the locks, the EFFECTIVE (clin, slin) pair — a CLIN move that keeps the old SLIN is refused.
      const effectiveClin = (updateData.clinId as string | undefined) ?? current.clinId;
      const effectiveSlin = 'slinId' in updateData ? (updateData.slinId as string | null) : current.slinId;
      await assertSlinOnClin(tx, effectiveClin, effectiveSlin);
      const [row] = await tx.update(chargeCodes).set(updateData).where(eq(chargeCodes.id, id)).returning();
      return row;
    });
  });
}

/**
 * Soft-delete a charge code. Never hard-delete — historical entries reference it. User assignments are kept (ruling Q2),
 * so employees can still correct existing hours (C4) and a reactivation gives the code back. Logged (CO-D8).
 */
export async function deactivateChargeCode(id: string) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    await db.transaction(async (tx) => {
      const [current] = await tx.select({ isActive: chargeCodes.isActive }).from(chargeCodes).where(eq(chargeCodes.id, id)).for('update');
      if (!current) throw new UserFacingError('Charge code not found.', 'not_found');
      if (!current.isActive) return;
      await tx.update(chargeCodes).set({ isActive: false, updatedAt: new Date() }).where(eq(chargeCodes.id, id));
      await logAdminChange(tx, {
        actorId: actor.id, entity: 'charge_code', entityId: id, action: 'deactivated',
        oldValue: { isActive: true }, newValue: { isActive: false },
      });
    });
  });
}

/** Employees still assigned to a charge code, and whether its CLIN, SLIN (if any) and contract are active — for the reactivate dialog. */
export async function getChargeCodeReactivationInfo(id: string): Promise<{ stillAssigned: number; assignable: boolean }> {
  await requireAdmin();
  const db = await getDb();
  const [code] = await db.select({ clinActive: clins.status, slinStatus: slins.status, contractActive: contracts.status })
    .from(chargeCodes).innerJoin(clins, eq(chargeCodes.clinId, clins.id)).innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
    .where(eq(chargeCodes.id, id));
  const assigned = await db.select({ id: userChargeCodes.id }).from(userChargeCodes)
    .innerJoin(users, eq(userChargeCodes.userId, users.id))
    // F11: only ACTIVE employees get the code back — a deactivated user's assignment is not counted.
    .where(and(eq(userChargeCodes.chargeCodeId, id), eq(userChargeCodes.isActive, true), eq(users.isActive, true)));
  const slinOk = code?.slinStatus == null || code.slinStatus === 'active'; // B5: a deactivated SLIN closes its codes too
  return { stillAssigned: assigned.length, assignable: code?.clinActive === 'active' && slinOk && code?.contractActive === 'active' };
}

/**
 * Reactivate a deactivated charge code (feature-plan-certified-outputs.md C3, CO-D8 — a mistake, an option year, an
 * extension). Ruling Q2: user assignments were never removed, so everyone still assigned sees the code again; the log
 * row records how many. The code is assignable again only while its CLIN and contract are active (the existing rule).
 */
export async function reactivateChargeCode(id: string) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const [current] = await tx.select({ isActive: chargeCodes.isActive }).from(chargeCodes).where(eq(chargeCodes.id, id)).for('update');
      if (!current) throw new UserFacingError('Charge code not found.', 'not_found');
      const assigned = await tx.select({ id: userChargeCodes.id }).from(userChargeCodes)
        .innerJoin(users, eq(userChargeCodes.userId, users.id))
        // F11: count active employees only (they are the ones who see the code again).
        .where(and(eq(userChargeCodes.chargeCodeId, id), eq(userChargeCodes.isActive, true), eq(users.isActive, true)));
      if (current.isActive) return { stillAssigned: assigned.length };
      await tx.update(chargeCodes).set({ isActive: true, updatedAt: new Date() }).where(eq(chargeCodes.id, id));
      await logAdminChange(tx, {
        actorId: actor.id, entity: 'charge_code', entityId: id, action: 'reactivated',
        oldValue: { isActive: false }, newValue: { isActive: true, stillAssigned: assigned.length },
      });
      return { stillAssigned: assigned.length };
    });
  });
}

// ---------------------------------------------------------------------------
// User → Charge Code assignment
// ---------------------------------------------------------------------------

/**
 * Give a person access to charge codes (feature-plan-ux-people-codes.md §4.2), all or nothing, in one transaction: the
 * person must be active and every code chargeable (else nothing is written and the first refused code is named).
 * Codes already actively held are left alone (their assignedBy isn't overwritten); the rest go through
 * assignChargeCodeToUserInternal, which also upserts the person's CLIN row (R8: unchanged — for a supervisor that is
 * approval scope, which the dialog warns about).
 */
export async function assignChargeCodesToUser(data: { userId: string; chargeCodeIds: string[] }): Promise<ActionResult<{ assigned: number }>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    if (!data?.userId) throw new UserFacingError('Choose a person.');
    const userId = validateUUID(data.userId, 'Person');
    if (!Array.isArray(data.chargeCodeIds) || data.chargeCodeIds.length === 0) throw new UserFacingError('Choose at least one charge code.');
    const ids = [...new Set(data.chargeCodeIds.map((id) => validateUUID(id, 'Charge code')))];
    if (ids.length > 200) throw new UserFacingError('Choose 200 charge codes or fewer at a time.');
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const [person] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, userId));
      if (!person?.isActive) throw new UserFacingError('Choose an active person.');
      const found = await tx
        .select({ id: chargeCodes.id, code: chargeCodes.code, chargeable: sql<boolean>`${CHARGEABLE_CODE}`.mapWith(Boolean) })
        .from(chargeCodes)
        .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
        .innerJoin(contracts, eq(clins.contractId, contracts.id))
        .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
        .where(inArray(chargeCodes.id, ids));
      const byId = new Map(found.map((c) => [c.id, c]));
      for (const id of ids) {
        const c = byId.get(id);
        if (!c?.chargeable) throw new UserFacingError(`${c?.code ?? 'A charge code'} can't be charged right now. Refresh and try again.`);
      }
      const held = new Set((await tx.select({ chargeCodeId: userChargeCodes.chargeCodeId }).from(userChargeCodes)
        .where(and(eq(userChargeCodes.userId, userId), eq(userChargeCodes.isActive, true), inArray(userChargeCodes.chargeCodeId, ids))))
        .map((r) => r.chargeCodeId));
      const toAssign = ids.filter((id) => !held.has(id));
      for (const id of toAssign) await assignChargeCodeToUserInternal(tx, actor.id, userId, id);
      return { assigned: toAssign.length };
    });
  });
}

export async function unassignChargeCodeFromUser(userId: string, chargeCodeId: string) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    await db.update(userChargeCodes).set({ isActive: false })
      .where(and(eq(userChargeCodes.userId, userId), eq(userChargeCodes.chargeCodeId, chargeCodeId)));
  });
}

export async function getUserChargeCodeIds(userId: string): Promise<string[]> {
  await requireAdmin();
  const db = await getDb();
  const rows = await db.select({ chargeCodeId: userChargeCodes.chargeCodeId })
    .from(userChargeCodes)
    .where(and(eq(userChargeCodes.userId, userId), eq(userChargeCodes.isActive, true)));
  return rows.map((r) => r.chargeCodeId);
}

/**
 * Read-only: all user↔charge-code assignments (active and inactive) with joined
 * display fields, for the admin Assignments table (Charge code access).
 */
export async function getChargeCodeAssignments() {
  await requireAdmin();
  const db = await getDb();
  return db
    .select({
      userId: userChargeCodes.userId,
      userName: users.fullName,
      chargeCodeId: chargeCodes.id,
      code: chargeCodes.code,
      name: chargeCodes.name,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      workLocation: chargeCodes.workLocation,
      isActive: userChargeCodes.isActive,
      assignedAt: userChargeCodes.assignedAt,
    })
    .from(userChargeCodes)
    .innerJoin(chargeCodes, eq(userChargeCodes.chargeCodeId, chargeCodes.id))
    .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .innerJoin(users, eq(userChargeCodes.userId, users.id))
    .orderBy(users.fullName, contracts.name, clins.clinNumber, chargeCodes.code);
}

// ---------------------------------------------------------------------------
// Create codes from CLINs (feature-plan-ux-people-codes.md §3.3; onboarding path A)
// ---------------------------------------------------------------------------

export interface AutobridgeCandidate {
  clinId: string;
  code: string;
  name: string;
  contractName: string;
  clinNumber: string;
  available: boolean;
  reason?: string;
}

/** Every qualifying CLIN (active, on an active contract, with no code at all), and whether its code can be created. */
async function autobridgeCandidates(db: Pick<ReadDb, 'select'>): Promise<AutobridgeCandidate[]> {
  const rows = await db
    .select({ clinId: clins.id, clinNumber: clins.clinNumber, description: clins.description, contractName: contracts.name, contractNumber: contracts.contractNumber })
    .from(clins)
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(chargeCodes, eq(chargeCodes.clinId, clins.id))
    .where(and(eq(clins.status, 'active'), eq(contracts.status, 'active'), isNull(chargeCodes.id)));
  const wanted = rows.map((r) => ({ ...r, code: `${r.contractNumber}-${r.clinNumber}` }));
  const shortCodes = wanted.filter((w) => w.code.length <= 100).map((w) => w.code);
  // charge_codes.code is globally unique: a code string another code already uses can't be created.
  const taken = new Set(shortCodes.length === 0 ? [] : (await db.select({ code: chargeCodes.code }).from(chargeCodes).where(inArray(chargeCodes.code, shortCodes))).map((r) => r.code));
  return wanted
    .map((w): AutobridgeCandidate => {
      const name = (w.description ?? `${w.contractNumber} / ${w.clinNumber}`).slice(0, 255);
      const base = { clinId: w.clinId, code: w.code, name, contractName: w.contractName, clinNumber: w.clinNumber };
      if (w.code.length > 100) return { ...base, available: false, reason: 'Code would be too long — add one yourself.' };
      if (taken.has(w.code)) return { ...base, available: false, reason: `Code ${w.code} is already used — add one yourself.` };
      return { ...base, available: true };
    })
    .sort((a, b) => a.contractName.localeCompare(b.contractName) || a.clinNumber.localeCompare(b.clinNumber, undefined, { numeric: true }));
}

/** What "Create codes from CLINs" would create (read-only; the modal ticks the available ones). */
export async function previewAutobridgeChargeCodes(): Promise<AutobridgeCandidate[]> {
  await requireAdmin();
  const db = await getDb();
  return autobridgeCandidates(db);
}

/**
 * Create one code per qualifying, available CLIN — every one (no argument: the Setup wizard) or the ticked ones. One
 * transaction; `onConflictDoNothing().returning()` so a concurrent create is reported as skipped, never counted.
 * `skipped` = requested − created, where requested is every id passed (ids no longer qualifying count as skipped).
 */
export async function autobridgeChargeCodesFromClins(clinIds?: string[]): Promise<ActionResult<{ created: number; skipped: number }>> {
  return userAction(async () => {
    await requireAdminFresh();
    let requested: string[] | null = null;
    if (clinIds !== undefined) {
      if (!Array.isArray(clinIds)) throw new UserFacingError('Tick at least one CLIN.');
      requested = [...new Set(clinIds.map((id) => validateUUID(id, 'CLIN')))];
      if (requested.length === 0) throw new UserFacingError('Tick at least one CLIN.');
      if (requested.length > 500) throw new UserFacingError('Choose 500 CLINs or fewer at a time.');
    }
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const available = (await autobridgeCandidates(tx)).filter((c) => c.available && (!requested || requested.includes(c.clinId)));
      const inserted = available.length === 0 ? [] : await tx.insert(chargeCodes)
        .values(available.map((c) => ({ code: c.code, name: c.name, clinId: c.clinId })))
        .onConflictDoNothing()
        .returning({ id: chargeCodes.id });
      const total = requested ? requested.length : available.length;
      return { created: inserted.length, skipped: total - inserted.length };
    });
  });
}
