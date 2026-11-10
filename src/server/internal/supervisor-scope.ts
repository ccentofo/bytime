import 'server-only';
import { and, eq } from 'drizzle-orm';
import { getDb, type ReadDb } from '@/db';
import { approvalScopes, userAssignments } from '@/db/schema';
import { approvableScope, effectiveDesignee, loadApprovalFacts } from './approval-rules';

/**
 * The Approvals page scope sentence for a supervisor (INTERNAL — exposed via getMyScopeInfo() for the SESSION user
 * only). UX-2 ruling: nobody counted twice, and the same people as Home's team (approvableScope):
 * - approvableEmployeeCount (n): people the supervisor can approve through a shared CLIN who did NOT designate them;
 * - designatedByCount (k): people who designated the supervisor (effective designee, any role).
 * n + k = approvableScope(...).length. Peers who merely share a CLIN appear in neither. assignedClinCount (m) is the
 * supervisor's active APPROVAL SCOPE CLINs (approval_scopes).
 */
export async function getSupervisorScopeInfo(supervisorId: string): Promise<{
  assignedContractCount: number;
  assignedClinCount: number;
  approvableEmployeeCount: number;
  designatedByCount: number;
}> {
  const facts = await loadApprovalFacts(await getDb());
  const team = approvableScope(facts, supervisorId);
  const designators = team.filter((id) => effectiveDesignee(facts, id) === supervisorId);
  return {
    assignedContractCount: 0, // Will be enriched in Phase B if needed
    assignedClinCount: facts.scopeClinsBySupervisor.get(supervisorId)?.size ?? 0, // feature-plan-approval-scope.md §4.1: the active scope
    approvableEmployeeCount: team.length - designators.length,
    designatedByCount: designators.length,
  };
}

/**
 * feature-plan-approval-scope.md S4: the CLINs a supervisor's own report and audit filter dropdowns offer — their active
 * approval scope ∪ their own active CLIN membership (what they approve, plus what they charge).
 */
export async function ownFilterClinIds(db: Pick<ReadDb, 'select'>, userId: string): Promise<string[]> {
  const [scope, member] = await Promise.all([
    db.select({ clinId: approvalScopes.clinId }).from(approvalScopes).where(and(eq(approvalScopes.supervisorId, userId), eq(approvalScopes.isActive, true))),
    db.select({ clinId: userAssignments.clinId }).from(userAssignments).where(and(eq(userAssignments.userId, userId), eq(userAssignments.isActive, true))),
  ]);
  return [...new Set([...scope, ...member].map((r) => r.clinId))];
}
