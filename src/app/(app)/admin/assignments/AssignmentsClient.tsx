'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Tabs } from '@mantine/core';
import { getAssignments } from '@/server/actions/assignments';
import { getChargeCodeAssignments } from '@/server/actions/charge-codes';
import { toastError } from '@/lib/toast';
import { PageHeader } from '@/components/ui/PageHeader';
import type { CalendarDate } from '@/lib/calendar-date';
import { parseAssignmentsParams, type AssignmentsTab } from '@/lib/assignments-params';
import { ChargeCodeAccessPanel, type CodeAccessRow } from './ChargeCodeAccessPanel';
import { ApprovalScopePanel, type ActiveClin, type ScopeAssignment } from './ApprovalScopePanel';
import type { AccessCode, AccessPerson } from './GiveAccessModal';
import {
  LaborCategoryAssignmentsPanel, type AssignableLcat, type LcatAssignment, type LcatFilterKey,
} from './LaborCategoryAssignmentsPanel';

type User = AccessPerson & { email: string; approverId?: string | null };
type Assignment = ScopeAssignment & { slinId: string | null; userEmail: string; slinNumber: string | null; slinDescription: string | null };

type Props = {
  initialAssignments: Assignment[];
  users: User[];
  /** Active CLINs on active contracts (§4.1: the pickers and the uncovered line). */
  activeClins: ActiveClin[];
  chargeCodes: AccessCode[];
  initialChargeCodeAssignments: CodeAccessRow[];
  workspaceTimezone: string;
  /** supervisorId → their effective approver's name (null = admins), computed on the server (§4.4). */
  approverNames?: Record<string, string | null>;
  /** The server's allowlisted `tab` — used only when the URL can't be read (the client re-derives it). */
  initialTab: AssignmentsTab;
  /** The "Labor categories" tab's data (feature-plan-ux-kit-contracts.md §4.3). */
  lcat: {
    initialAssignments: LcatAssignment[];
    assignableLcats: AssignableLcat[];
    rateByCategory: Record<string, string | null>;
    categoryNames: Record<string, { lcatCode: string; clinNumber: string; slinNumber?: string | null }>;
    today: CalendarDate;
    overlapIds?: string[];
  };
};

/**
 * Assignments (feature-plan-ux-people-codes.md §4): Charge code access | Labor categories | Approval scope. The tab and
 * the labor-category filters live in the URL; a tab switch REPLACES only `tab` (history.replaceState — Next keeps
 * useSearchParams in sync), so the filters survive it (§4.1). After every write the panel's data is refetched into state.
 */
export function AssignmentsClient({
  initialAssignments, users, activeClins, chargeCodes, initialChargeCodeAssignments, workspaceTimezone, approverNames = {}, initialTab, lcat,
}: Props) {
  const searchParams = useSearchParams();
  const params = parseAssignmentsParams((k) => searchParams?.get(k));
  const tab = searchParams ? params.tab : initialTab;
  function switchTab(value: string | null) {
    if (!value || value === tab) return;
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    next.set('tab', value); // laborCategoryId, userId and assignments are kept (§4.1)
    window.history.replaceState(null, '', `?${next.toString()}`);
  }
  function removeFilter(key: LcatFilterKey) {
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    next.delete(key);
    if (key === 'userId') next.delete('assignments'); // the highlight belongs to that employee's overlap
    window.history.replaceState(null, '', `?${next.toString()}`);
  }

  const [assignments, setAssignments] = useState<Assignment[]>(initialAssignments);
  const [access, setAccess] = useState<CodeAccessRow[]>(initialChargeCodeAssignments);
  async function refresh() {
    try {
      const [a, c] = await Promise.all([getAssignments(), getChargeCodeAssignments()]);
      setAssignments(a as Assignment[]);
      setAccess(c as CodeAccessRow[]);
    } catch {
      toastError({ title: 'List not refreshed', message: 'Saved, but the list couldn’t refresh. Reload the page.' });
    }
  }

  // personId → the CLIN ids of their active user_assignments rows (the R8 notice in Give access).
  const clinsBy = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of assignments) if (a.isActive) m.set(a.userId, new Set([...(m.get(a.userId) ?? []), a.clinId]));
    return m;
  }, [assignments]);

  return (
    <>
      <PageHeader
        title="Assignments"
        description="What each person can charge, which labor category prices their hours, and which CLINs each supervisor approves."
      />

      <Tabs value={tab} onChange={switchTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="charge-codes">Charge code access</Tabs.Tab>
          <Tabs.Tab value="labor-categories">Labor categories</Tabs.Tab>
          <Tabs.Tab value="approval-scope">Approval scope</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="charge-codes">
          <ChargeCodeAccessPanel people={users} access={access} codes={chargeCodes} clinsBy={clinsBy} onChanged={refresh} />
        </Tabs.Panel>

        <Tabs.Panel value="labor-categories">
          <LaborCategoryAssignmentsPanel
            {...lcat}
            users={users}
            filters={tab === 'labor-categories' ? params : { laborCategoryId: null, userId: null, assignments: [] }}
            onRemoveFilter={removeFilter}
          />
        </Tabs.Panel>

        <Tabs.Panel value="approval-scope">
          <ApprovalScopePanel
            people={users}
            assignments={assignments}
            activeClins={activeClins}
            approverNames={approverNames}
            workspaceTimezone={workspaceTimezone}
            onChanged={refresh}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
