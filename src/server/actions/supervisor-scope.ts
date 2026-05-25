'use server';

import { db } from '@/db';
import { userAssignments, users } from '@/db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';

/**
 * Get the list of employee IDs that a supervisor is authorized to review.
 *
 * Logic: A supervisor can review employees who share at least one active CLIN
 * assignment with them. This is derived by:
 * 1. Finding all CLINs the supervisor is assigned to
 * 2. Finding all other users assigned to those same CLINs
 * 3. Returning the unique set of those user IDs (excluding the supervisor themselves)
 *
 * Admin users bypass this entirely — they can review all employees.
 */
export async function getSupervisedEmployeeIds(
  supervisorId: string,
  supervisorRole: string
): Promise<string[] | 'all'> {
  // Admins see everything
  if (supervisorRole === 'admin') {
    return 'all';
  }

  // Get CLINs the supervisor is assigned to
  const supervisorClins = await db
    .select({ clinId: userAssignments.clinId })
    .from(userAssignments)
    .where(
      and(
        eq(userAssignments.userId, supervisorId),
        eq(userAssignments.isActive, true),
      )
    );

  if (supervisorClins.length === 0) {
    return []; // Supervisor has no assignments — can't review anyone
  }

  const clinIds = supervisorClins.map((r) => r.clinId);

  // Get all users assigned to those same CLINs (excluding the supervisor)
  const supervisedUsers = await db
    .select({ userId: userAssignments.userId })
    .from(userAssignments)
    .where(
      and(
        inArray(userAssignments.clinId, clinIds),
        eq(userAssignments.isActive, true),
      )
    );

  // Deduplicate and exclude the supervisor themselves
  const uniqueIds = [...new Set(supervisedUsers.map((r) => r.userId))];
  return uniqueIds.filter((id) => id !== supervisorId);
}

/**
 * Get the contracts shared between a supervisor and their supervised employees.
 * Used for displaying scope context in the UI.
 */
export async function getSupervisorScopeInfo(supervisorId: string): Promise<{
  assignedContractCount: number;
  assignedClinCount: number;
  supervisedEmployeeCount: number;
}> {
  // Count supervisor's CLIN assignments
  const clinAssignments = await db
    .select({ clinId: userAssignments.clinId })
    .from(userAssignments)
    .where(
      and(
        eq(userAssignments.userId, supervisorId),
        eq(userAssignments.isActive, true),
      )
    );

  const clinIds = clinAssignments.map((r) => r.clinId);

  if (clinIds.length === 0) {
    return { assignedContractCount: 0, assignedClinCount: 0, supervisedEmployeeCount: 0 };
  }

  // Count unique employees on those CLINs
  const employees = await db
    .select({ userId: userAssignments.userId })
    .from(userAssignments)
    .where(
      and(
        inArray(userAssignments.clinId, clinIds),
        eq(userAssignments.isActive, true),
      )
    );

  const uniqueEmployees = new Set(employees.map((r) => r.userId));
  uniqueEmployees.delete(supervisorId); // Don't count self

  // Count unique contracts (via CLINs)
  // For simplicity, we count unique CLINs; contract count would require a join
  return {
    assignedContractCount: 0, // Will be enriched in Phase B if needed
    assignedClinCount: clinIds.length,
    supervisedEmployeeCount: uniqueEmployees.size,
  };
}
