import 'server-only';
import { getDb } from '@/db';
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
