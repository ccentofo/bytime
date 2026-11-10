import 'server-only';
import { eq } from 'drizzle-orm';
import type { TenantWriter } from '@/db';
import { chargeCodes, clins, contracts, costClasses, laborCategories, slins, userChargeCodes, userAssignments } from '@/db/schema';
import { UserFacingError } from '@/lib/errors';
import { validateOptionalString } from '@/lib/validation';
import { CATEGORY_MESSAGES, categoryFitsCode } from '@/lib/labor-rates';

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

// ── Validation (feature-plan-ux-people-codes.md §3.4; feature-plan-ux-setup-import.md §4.3): shared by createChargeCode,
// updateChargeCode's field rules and the charge-code import. Not inside createChargeCodeInternal, so the QBO import keeps
// its own rules. ────────────────────────────────────────────────────────────────────────────────────────────────────

export function validCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code) throw new UserFacingError('Enter a code.');
  if (code.length > 100) throw new UserFacingError('The code must be 100 characters or fewer.');
  return code;
}
export function validName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new UserFacingError('Enter a name.');
  if (name.length > 255) throw new UserFacingError('The name must be 255 characters or fewer.');
  return name;
}

/** The SLIN (if any) must sit on the CLIN — checked on the EFFECTIVE pair, after an update is merged. */
export async function assertSlinOnClin(tx: TenantWriter, clinId: string, slinId: string | null | undefined) {
  if (!slinId) return;
  const [slin] = await tx.select({ clinId: slins.clinId }).from(slins).where(eq(slins.id, slinId));
  if (!slin || slin.clinId !== clinId) throw new UserFacingError("That SLIN isn't on the chosen CLIN.");
}

const WORK_LOCATIONS = ['onsite', 'telework', 'other'] as const;
export const WORK_LOCATION_MESSAGE = 'Location must be Onsite, Telework or Other.';

/**
 * A new charge code's rules, on TYPED values (the import parses its strings first): code / name / description lengths;
 * an active CLIN on an active contract; the SLIN on that CLIN; the work location one of the enum's values (not a Postgres
 * enum error); a labor category that fits the code (DR-Q2: its CLIN, and its SLIN when both have one). Run inside the
 * caller's transaction (or a row's savepoint). Returns the input for createChargeCodeInternal.
 */
export async function validateChargeCodeInput(tx: TenantWriter, input: {
  code: unknown; name: unknown; description?: unknown; clinId: string; slinId?: string | null; laborCategoryId?: string | null;
  classId?: string | null; workLocation?: unknown; billable?: unknown;
}): Promise<ChargeCodeInput> {
  const code = validCode(input.code);
  const name = validName(input.name);
  const description = validateOptionalString(input.description, 'Description', 2000);
  const workLocation = input.workLocation === undefined || input.workLocation === null || input.workLocation === '' ? undefined : input.workLocation;
  if (workLocation !== undefined && !(WORK_LOCATIONS as readonly unknown[]).includes(workLocation)) throw new UserFacingError(WORK_LOCATION_MESSAGE);
  if (input.billable !== undefined && typeof input.billable !== 'boolean') throw new UserFacingError('Billable must be Yes or No.');
  const [clin] = await tx.select({ clinStatus: clins.status, contractStatus: contracts.status })
    .from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id)).where(eq(clins.id, input.clinId));
  if (!clin || clin.clinStatus !== 'active' || clin.contractStatus !== 'active') throw new UserFacingError('Choose an active CLIN.');
  await assertSlinOnClin(tx, input.clinId, input.slinId);
  if (input.laborCategoryId) {
    const [category] = await tx.select({ clinId: laborCategories.clinId, slinId: laborCategories.slinId }).from(laborCategories)
      .where(eq(laborCategories.id, input.laborCategoryId));
    if (!category) throw new UserFacingError(CATEGORY_MESSAGES.categoryNotFound);
    if (!categoryFitsCode(category, { clinId: input.clinId, slinId: input.slinId ?? null })) throw new UserFacingError(CATEGORY_MESSAGES.wrongClin);
  }
  return {
    code, name, description, clinId: input.clinId,
    slinId: input.slinId ?? undefined,
    laborCategoryId: input.laborCategoryId ?? undefined,
    classId: input.classId ?? undefined,
    workLocation: workLocation as ChargeCodeInput['workLocation'],
    billable: input.billable as boolean | undefined,
  };
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
 * Assign a charge code to a user, and upsert the user_assignments row (CLIN MEMBERSHIP) for the code's CLIN, so LCAT
 * rates and who-works-where stay intact. Membership never grants approval authority (feature-plan-approval-scope.md S1,
 * S8): approval scope is only ever granted on Assignments → Approval scope.
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

  // CRITICAL: also ensure the user has a user_assignments (membership) row for the CLIN, so LCAT lookups and the
  // supervisors whose approval scope covers this CLIN see them. It never gives THIS user approval authority.
  await db.insert(userAssignments).values({
    userId, clinId: cc.clinId, slinId: cc.slinId ?? null, isActive: true, assignedBy: actorId,
  }).onConflictDoUpdate({
    target: [userAssignments.userId, userAssignments.clinId],
    set: { isActive: true },
  });
}
