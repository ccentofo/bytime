'use server';

import { getDb, getDbForWrite } from '@/db';
import { userAssignments, users, clins, contracts, slins } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { userAction } from '@/lib/action-result';
import { UserFacingError } from '@/lib/errors';
import { validateUUID } from '@/lib/validation';

export async function getAssignments() {
  await requireAdmin();
  const db = await getDb();
  return db
    .select({
      id: userAssignments.id,
      userId: userAssignments.userId,
      clinId: userAssignments.clinId,
      slinId: userAssignments.slinId,
      isActive: userAssignments.isActive,
      assignedAt: userAssignments.assignedAt,
      userName: users.fullName,
      userEmail: users.email,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
      slinDescription: slins.description,
    })
    .from(userAssignments)
    .innerJoin(users, eq(userAssignments.userId, users.id))
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(userAssignments.slinId, slins.id))
    .orderBy(users.fullName, contracts.name);
}

export async function getAssignmentsForUser(userId: string) {
  await requireAdmin();
  const db = await getDb();
  return db
    .select({
      id: userAssignments.id,
      clinId: userAssignments.clinId,
      slinId: userAssignments.slinId,
      isActive: userAssignments.isActive,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(userAssignments.slinId, slins.id))
    .where(eq(userAssignments.userId, userId))
    .orderBy(contracts.name);
}

/**
 * Add a CLIN to a supervisor's approval scope (feature-plan-ux-people-codes.md §4.4). The person must exist, be active
 * and be a supervisor; the CLIN must exist. No SLIN (approval matches by CLIN only — R2).
 */
export async function assignUserToClin(data: { userId: string; clinId: string }) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    if (!data?.userId) throw new UserFacingError('Choose an active supervisor.');
    if (!data.clinId) throw new UserFacingError('Choose a CLIN.');
    const userId = validateUUID(data.userId, 'Supervisor');
    const clinId = validateUUID(data.clinId, 'CLIN');
    const db = await getDbForWrite();
    const [person] = await db.select({ role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, userId));
    if (!person || !person.isActive || person.role !== 'supervisor') throw new UserFacingError('Choose an active supervisor.');
    const [clin] = await db.select({ id: clins.id }).from(clins).where(eq(clins.id, clinId));
    if (!clin) throw new UserFacingError('CLIN not found.', 'not_found');
    // R2-6: explicit allowlist — isActive/assignedAt/assignedBy are real columns on this table
    // that spreading the caller's object wholesale would otherwise expose to forgery.
    const rows = await db
      .insert(userAssignments)
      .values({ userId, clinId, slinId: null, assignedBy: actor.id })
      .onConflictDoUpdate({
        target: [userAssignments.userId, userAssignments.clinId],
        set: { isActive: true, assignedAt: new Date() },
      })
      .returning();
    return rows[0];
  });
}

export async function unassignUserFromClin(userId: string, clinId: string) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    const rows = await db
      .update(userAssignments)
      .set({ isActive: false })
      .where(and(eq(userAssignments.userId, userId), eq(userAssignments.clinId, clinId)))
      .returning();
    return rows[0];
  });
}
