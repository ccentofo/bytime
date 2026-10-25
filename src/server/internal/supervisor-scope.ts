import 'server-only';
import { getDb } from '@/db';
import { userAssignments } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { effectiveDesignee, loadApprovalFacts, reviewScopeFrom } from './approval-rules';

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
 *
 * INTERNAL — not a server action. The app's review scope is src/server/internal/approval-rules.ts (reviewScope:
 * these CLIN sharers plus designations); this CLIN-only derivation is kept for its integration test.
 */
export async function getSupervisedEmployeeIds(
  supervisorId: string,
  supervisorRole: string
): Promise<string[] | 'all'> {
  const db = await getDb();
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
 * The Approvals page banner counts for a supervisor (INTERNAL — exposed via getMyScopeInfo() for the SESSION user
 * only). feature-plan-certified-outputs.md C2: the employee count is the review scope (CLIN sharers + the users who
 * designated this supervisor as approver), so a designee with no CLINs isn't told "no employees in your scope".
 */
export async function getSupervisorScopeInfo(supervisorId: string): Promise<{
  assignedContractCount: number;
  assignedClinCount: number;
  supervisedEmployeeCount: number;
  designatedByCount: number;
}> {
  const facts = await loadApprovalFacts(await getDb());
  const scope = reviewScopeFrom(facts, supervisorId);
  const others = scope === 'all' ? [...facts.users.keys()] : scope;
  const designatedBy = [...facts.users.values()].filter((u) => effectiveDesignee(facts, u.id) === supervisorId).length;
  return {
    assignedContractCount: 0, // Will be enriched in Phase B if needed
    assignedClinCount: facts.clinsByUser.get(supervisorId)?.size ?? 0,
    supervisedEmployeeCount: others.filter((id) => id !== supervisorId).length,
    designatedByCount: designatedBy,
  };
}
