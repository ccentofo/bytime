import 'server-only';
import { eq } from 'drizzle-orm';
import type { TenantWriter } from '@/db';
import { chargeCodes, costClasses, userChargeCodes, userAssignments } from '@/db/schema';
import { UserFacingError } from '@/lib/errors';

/**
 * Charge-code writers shared by the charge-code and QBO-import actions (feature-plan-launch-blockers.md P4 §2:
 * exported actions never call each other). INTERNAL — no guard of their own: the caller is a guarded action that
 * passes its write-gated client. They throw typed errors and never return a failure from inside a transaction.
 */

export async function createCostClassInternal(db: TenantWriter, name: string) {
  const [row] = await db.insert(costClasses).values({ name: name.trim() }).onConflictDoNothing().returning();
  return row;
}

export interface ChargeCodeInput {
  code: string;
  name: string;
  description?: string;
  clinId: string;
  slinId?: string;
  laborCategoryId?: string;
  classId?: string;
  workLocation?: 'onsite' | 'telework' | 'other';
  billable?: boolean;
}

export async function createChargeCodeInternal(db: TenantWriter, data: ChargeCodeInput) {
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

/**
 * Assign a charge code to a user, and upsert the user_assignments row for the code's CLIN so supervisor approval
 * routing and LCAT rates stay intact.
 */
export async function assignChargeCodeToUserInternal(db: TenantWriter, actorId: string, userId: string, chargeCodeId: string): Promise<void> {
  const [cc] = await db.select({ clinId: chargeCodes.clinId, slinId: chargeCodes.slinId })
    .from(chargeCodes).where(eq(chargeCodes.id, chargeCodeId)).limit(1);
  if (!cc) throw new UserFacingError(`Charge code ${chargeCodeId} not found.`, 'not_found');

  await db.insert(userChargeCodes).values({
    userId, chargeCodeId, isActive: true, assignedBy: actorId,
  }).onConflictDoUpdate({
    target: [userChargeCodes.userId, userChargeCodes.chargeCodeId],
    set: { isActive: true, assignedBy: actorId },
  });

  // CRITICAL: also ensure the user has a user_assignments row for the CLIN
  // so supervisor scope and LCAT lookups work correctly.
  await db.insert(userAssignments).values({
    userId, clinId: cc.clinId, slinId: cc.slinId ?? null, isActive: true, assignedBy: actorId,
  }).onConflictDoUpdate({
    target: [userAssignments.userId, userAssignments.clinId],
    set: { isActive: true },
  });
}
