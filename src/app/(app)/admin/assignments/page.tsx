import { requirePageRole } from '@/lib/session';
import { getApprovalClinOptions, getApprovalScopesView } from '@/server/actions/assignments';
import { getUsers } from '@/server/actions/users';
import { listChargeCodes, getChargeCodeAssignments } from '@/server/actions/charge-codes';
import { getAllLaborCategories, getUserLaborCategoryAssignments, getAssignableLaborCategories } from '@/server/actions/labor-categories';
import { getWorkspaceTimezone, getWorkspaceToday } from '@/server/internal/workspace-settings';
import { findOverlaps, overlapAssignmentIds } from '@/server/internal/cost-basis';
import { effectiveDesignee, type ApprovalFacts } from '@/server/internal/approval-rules';
import { firstParam, parseAssignmentsParams } from '@/lib/assignments-params';
import { rateDisplay } from '@/lib/labor-rates';
import { AssignmentsClient } from './AssignmentsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Assignments' };

export const dynamic = 'force-dynamic';

type SearchParams = { tab?: string | string[]; laborCategoryId?: string | string[]; userId?: string | string[]; assignments?: string | string[] };

/**
 * Assignments (feature-plan-ux-people-codes.md §4): charge-code access by person, labor categories by person and
 * approval scope by supervisor. The server uses only `tab` (allowlisted) for the initial tab; the client reads the
 * filters from the URL. Ten loads at most (the pool's max): the workspace today and timezone share one cached settings
 * read; the overlaps (§4.3) and each supervisor's approver (§4.4) are computed here from rows already loaded.
 */
export default async function AssignmentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePageRole('admin');
  const sp = await searchParams;
  const { tab } = parseAssignmentsParams((k) => firstParam(sp[k as keyof SearchParams]));

  const [scopeView, allUsers, activeClins, allChargeCodes, chargeCodeAssignments, workspaceTimezone,
    laborCategories, lcatAssignments, assignableLcats, today] = await Promise.all([
    // feature-plan-approval-scope.md §4.2: the scope rows (with the review flag) and CLIN membership, one load slot.
    getApprovalScopesView(),
    getUsers(),
    // §4.1: the CLIN pickers and the uncovered line offer active CLINs on active contracts only.
    getApprovalClinOptions(),
    listChargeCodes(),
    getChargeCodeAssignments(),
    getWorkspaceTimezone(),
    getAllLaborCategories(), // L1: the current rate of EVERY category (an assignment to a deactivated one keeps its rate)
    getUserLaborCategoryAssignments(),
    getAssignableLaborCategories(),
    getWorkspaceToday(),
  ]);

  const rateByCategory: Record<string, string | null> = {};
  const categoryNames: Record<string, { lcatCode: string; clinNumber: string; slinNumber: string | null }> = {};
  const lcById = new Map(laborCategories.map((lc) => [lc.id, lc]));
  for (const lc of laborCategories) {
    const schedule = { starting: { hourlyRate: lc.hourlyRate, ceilingRate: lc.ceilingRate }, changes: lc.rateChanges };
    rateByCategory[lc.id] = rateDisplay(schedule, today).current?.hourlyRate ?? null;
    categoryNames[lc.id] = { lcatCode: lc.lcatCode, clinNumber: lc.clinNumber, slinNumber: lc.slinNumber ?? null };
  }

  // §4.3: the overlaps from the assignment rows already loaded (no 11th load), in findOverlaps' row shape.
  const overlapping = findOverlaps(lcatAssignments.flatMap((a) => {
    const lc = lcById.get(a.laborCategoryId);
    return lc ? [{
      assignmentId: a.id, userId: a.userId, employeeName: a.userName, effectiveDate: a.effectiveDate, endDate: a.endDate,
      lcId: lc.id, lcatCode: lc.lcatCode, title: lc.title, clinId: lc.clinId, clinNumber: lc.clinNumber, slinId: lc.slinId, slinNumber: lc.slinNumber ?? null,
      contractId: lc.contractId,
    }] : [];
  }));
  const overlapIds = overlapAssignmentIds(overlapping);

  // §4.4: each active supervisor's effective approver, by the same rule as approvals, from the users already loaded.
  const facts: ApprovalFacts = { users: new Map(allUsers.map((u) => [u.id, { id: u.id, role: u.role, isActive: u.isActive, approverId: u.approverId }])), clinsByUser: new Map(), scopeClinsBySupervisor: new Map() };
  const nameById = new Map(allUsers.map((u) => [u.id, u.fullName]));
  const approverNames: Record<string, string | null> = {};
  for (const u of allUsers) {
    if (u.role !== 'supervisor' || !u.isActive) continue;
    const designee = effectiveDesignee(facts, u.id);
    approverNames[u.id] = designee ? nameById.get(designee) ?? null : null;
  }

  return (
    <AssignmentsClient
      initialTab={tab}
      initialScopes={scopeView}
      users={allUsers}
      activeClins={activeClins}
      chargeCodes={allChargeCodes}
      initialChargeCodeAssignments={chargeCodeAssignments}
      workspaceTimezone={workspaceTimezone}
      approverNames={approverNames}
      lcat={{ initialAssignments: lcatAssignments, assignableLcats, rateByCategory, categoryNames, today, overlapIds }}
    />
  );
}
