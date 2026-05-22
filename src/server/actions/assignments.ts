'use server';

import { db } from '@/db';
import { userAssignments, users, clins, contracts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function getAssignments() {
  return db
    .select({
      id: userAssignments.id,
      userId: userAssignments.userId,
      clinId: userAssignments.clinId,
      isActive: userAssignments.isActive,
      assignedAt: userAssignments.assignedAt,
      userName: users.fullName,
      userEmail: users.email,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(userAssignments)
    .innerJoin(users, eq(userAssignments.userId, users.id))
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .orderBy(users.fullName, contracts.name);
}

export async function getAssignmentsForUser(userId: string) {
  return db
    .select({
      id: userAssignments.id,
      clinId: userAssignments.clinId,
      isActive: userAssignments.isActive,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(eq(userAssignments.userId, userId))
    .orderBy(contracts.name);
}

export async function assignUserToClin(data: {
  userId: string;
  clinId: string;
  assignedBy?: string;
}) {
  const rows = await db
    .insert(userAssignments)
    .values(data)
    .onConflictDoUpdate({
      target: [userAssignments.userId, userAssignments.clinId],
      set: { isActive: true, assignedAt: new Date() },
    })
    .returning();
  return rows[0];
}

export async function unassignUserFromClin(userId: string, clinId: string) {
  const rows = await db
    .update(userAssignments)
    .set({ isActive: false })
    .where(and(eq(userAssignments.userId, userId), eq(userAssignments.clinId, clinId)))
    .returning();
  return rows[0];
}
