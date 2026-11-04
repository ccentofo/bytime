import { requirePageRole } from '@/lib/session';
import { getAssignments } from '@/server/actions/assignments';
import { getUsers } from '@/server/actions/users';
import { getContracts } from '@/server/actions/contracts';
import { listChargeCodes, getChargeCodeAssignments } from '@/server/actions/charge-codes';
import { getAllLaborCategories, getUserLaborCategoryAssignments, getAssignableLaborCategories } from '@/server/actions/labor-categories';
import { getWorkspaceTimezone, getWorkspaceToday } from '@/server/internal/workspace-settings';
import { firstParam, parseAssignmentsParams } from '@/lib/assignments-params';
import { rateDisplay } from '@/lib/labor-rates';
import { AssignmentsClient } from './AssignmentsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Assignments' };

export const dynamic = 'force-dynamic';

type SearchParams = { tab?: string | string[]; laborCategoryId?: string | string[]; userId?: string | string[]; assignments?: string | string[] };

/**
 * Assignments: charge-code access, approval scope and (feature-plan-ux-kit-contracts.md §4.3) labor categories. The
 * server uses only `tab` (allowlisted) for the initial tab; the client reads the filters from the URL. Ten loads at most
 * (the pool's max): the workspace today and timezone share one cached settings read.
 */
export default async function AssignmentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePageRole('admin');
  const sp = await searchParams;
  const { tab } = parseAssignmentsParams((k) => firstParam(sp[k as keyof SearchParams]));

  const [assignments, allUsers, allContracts, allChargeCodes, chargeCodeAssignments, workspaceTimezone,
    laborCategories, lcatAssignments, assignableLcats, today] = await Promise.all([
    getAssignments(),
    getUsers(),
    getContracts(),
    listChargeCodes(),
    getChargeCodeAssignments(),
    getWorkspaceTimezone(),
    getAllLaborCategories(), // L1: the current rate of EVERY category (an assignment to a deactivated one keeps its rate)
    getUserLaborCategoryAssignments(),
    getAssignableLaborCategories(),
    getWorkspaceToday(),
  ]);

  const rateByCategory: Record<string, string | null> = {};
  const categoryNames: Record<string, { lcatCode: string; clinNumber: string }> = {};
  for (const lc of laborCategories) {
    const schedule = { starting: { hourlyRate: lc.hourlyRate, ceilingRate: lc.ceilingRate }, changes: lc.rateChanges };
    rateByCategory[lc.id] = rateDisplay(schedule, today).current?.hourlyRate ?? null;
    categoryNames[lc.id] = { lcatCode: lc.lcatCode, clinNumber: lc.clinNumber };
  }

  return (
    <AssignmentsClient
      initialTab={tab}
      initialAssignments={assignments}
      users={allUsers}
      contracts={allContracts}
      chargeCodes={allChargeCodes}
      initialChargeCodeAssignments={chargeCodeAssignments}
      workspaceTimezone={workspaceTimezone}
      lcat={{ initialAssignments: lcatAssignments, assignableLcats, rateByCategory, categoryNames, today }}
    />
  );
}
