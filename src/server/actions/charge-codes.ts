'use server';

import { getDb } from '@/db';
import { chargeCodes, costClasses, userChargeCodes, userAssignments, clins, contracts, slins, laborCategories, users } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';

// ---------------------------------------------------------------------------
// Cost Classes
// ---------------------------------------------------------------------------

export async function listCostClasses() {
  await requireAdmin();
  const db = await getDb();
  return db.select().from(costClasses).where(eq(costClasses.isActive, true)).orderBy(costClasses.name);
}

export async function createCostClass(name: string) {
  await requireAdmin();
  const db = await getDb();
  const [row] = await db.insert(costClasses).values({ name: name.trim() }).onConflictDoNothing().returning();
  return row;
}

// ---------------------------------------------------------------------------
// Charge Codes CRUD
// ---------------------------------------------------------------------------

export async function listChargeCodes() {
  await requireAdmin();
  const db = await getDb();
  return db
    .select({
      id: chargeCodes.id,
      code: chargeCodes.code,
      name: chargeCodes.name,
      description: chargeCodes.description,
      clinId: chargeCodes.clinId,
      clinNumber: clins.clinNumber,
      slinId: chargeCodes.slinId,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      laborCategoryId: chargeCodes.laborCategoryId,
      classId: chargeCodes.classId,
      className: costClasses.name,
      workLocation: chargeCodes.workLocation,
      billable: chargeCodes.billable,
      isActive: chargeCodes.isActive,
      createdAt: chargeCodes.createdAt,
    })
    .from(chargeCodes)
    .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(costClasses, eq(chargeCodes.classId, costClasses.id))
    .orderBy(contracts.name, clins.clinNumber, chargeCodes.code);
}

export async function createChargeCode(data: {
  code: string;
  name: string;
  description?: string;
  clinId: string;
  slinId?: string;
  laborCategoryId?: string;
  classId?: string;
  workLocation?: 'onsite' | 'telework' | 'other';
  billable?: boolean;
}) {
  await requireAdmin();
  const db = await getDb();
  const [row] = await db.insert(chargeCodes).values({
    code: data.code.trim(),
    name: data.name.trim(),
    description: data.description ?? null,
    clinId: data.clinId,
    slinId: data.slinId ?? null,
    laborCategoryId: data.laborCategoryId ?? null,
    classId: data.classId ?? null,
    workLocation: data.workLocation ?? null,
    billable: data.billable ?? true,
  }).returning();
  return row;
}

export async function updateChargeCode(id: string, data: {
  code?: string;
  name?: string;
  description?: string;
  clinId?: string;
  slinId?: string | null;
  laborCategoryId?: string | null;
  classId?: string | null;
  workLocation?: 'onsite' | 'telework' | 'other' | null;
  billable?: boolean;
}) {
  await requireAdmin();
  const db = await getDb();
  const [row] = await db.update(chargeCodes)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(chargeCodes.id, id))
    .returning();
  return row;
}

/**
 * Soft-delete a charge code. Never hard-delete — historical entries reference it.
 */
export async function deactivateChargeCode(id: string) {
  await requireAdmin();
  const db = await getDb();
  await db.update(chargeCodes).set({ isActive: false, updatedAt: new Date() }).where(eq(chargeCodes.id, id));
}

// ---------------------------------------------------------------------------
// User → Charge Code assignment
// ---------------------------------------------------------------------------

/**
 * Assign a charge code to a user.
 * ALSO upserts the user_assignments row for the code's CLIN so supervisor
 * approval routing and LCAT rates remain intact.
 */
export async function assignChargeCodeToUser(userId: string, chargeCodeId: string) {
  const actor = await requireAdmin();
  const db = await getDb();

  // Look up the charge code's CLIN (needed for user_assignments sync)
  const [cc] = await db.select({ clinId: chargeCodes.clinId, slinId: chargeCodes.slinId })
    .from(chargeCodes).where(eq(chargeCodes.id, chargeCodeId)).limit(1);
  if (!cc) throw new Error(`Charge code ${chargeCodeId} not found.`);

  // Upsert user_charge_codes
  await db.insert(userChargeCodes).values({
    userId, chargeCodeId, isActive: true, assignedBy: actor.id,
  }).onConflictDoUpdate({
    target: [userChargeCodes.userId, userChargeCodes.chargeCodeId],
    set: { isActive: true, assignedBy: actor.id },
  });

  // CRITICAL: also ensure the user has a user_assignments row for the CLIN
  // so supervisor scope and LCAT lookups work correctly.
  await db.insert(userAssignments).values({
    userId, clinId: cc.clinId, slinId: cc.slinId ?? null, isActive: true, assignedBy: actor.id,
  }).onConflictDoUpdate({
    target: [userAssignments.userId, userAssignments.clinId],
    set: { isActive: true },
  });

  return { success: true };
}

export async function unassignChargeCodeFromUser(userId: string, chargeCodeId: string) {
  await requireAdmin();
  const db = await getDb();
  await db.update(userChargeCodes).set({ isActive: false })
    .where(and(eq(userChargeCodes.userId, userId), eq(userChargeCodes.chargeCodeId, chargeCodeId)));
}

/**
 * Assign ALL active charge codes under a specific CLIN to a user.
 * Convenience for onboarding: "assign all codes under this CLIN."
 */
export async function assignAllUnderClin(userId: string, clinId: string) {
  await requireAdmin();
  const db = await getDb();
  const codes = await db.select({ id: chargeCodes.id })
    .from(chargeCodes)
    .where(and(eq(chargeCodes.clinId, clinId), eq(chargeCodes.isActive, true)));

  for (const code of codes) {
    await assignChargeCodeToUser(userId, code.id);
  }
  return { assigned: codes.length };
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
 * display fields, for the admin Assignments table. Mirrors the CLIN-assignment
 * table's shape (getAssignments in assignments.ts).
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
// Auto-bridge: generate one charge code per active CLIN (onboarding path A)
// ---------------------------------------------------------------------------

/**
 * For each active CLIN that has no charge codes, create one default code.
 * Idempotent — skips CLINs that already have at least one charge code.
 */
export async function autobridgeChargeCodesFromClins() {
  await requireAdmin();
  const db = await getDb();

  // Get all active CLINs with their contract info
  const activeclins = await db
    .select({
      id: clins.id,
      clinNumber: clins.clinNumber,
      description: clins.description,
      contractNumber: contracts.contractNumber,
    })
    .from(clins)
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(and(eq(clins.status, 'active'), eq(contracts.status, 'active')));

  // Find which CLINs already have at least one charge code
  const existingClinIds = new Set(
    (await db.select({ clinId: chargeCodes.clinId }).from(chargeCodes)).map((r) => r.clinId)
  );

  let created = 0;
  for (const clin of activeclins) {
    if (existingClinIds.has(clin.id)) continue;
    const code = `${clin.contractNumber}-${clin.clinNumber}`;
    const name = clin.description ?? `${clin.contractNumber} / ${clin.clinNumber}`;
    await db.insert(chargeCodes).values({ code, name, clinId: clin.id }).onConflictDoNothing();
    created++;
  }

  return { created, total: activeclins.length };
}
