import 'server-only';
import { getDb } from '@/db';
import { effectiveDesignee, loadApprovalFacts, reviewScopeFrom } from './approval-rules';

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
