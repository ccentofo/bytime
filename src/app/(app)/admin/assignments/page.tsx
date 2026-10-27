import { requirePageRole } from '@/lib/session';
import { getAssignments } from '@/server/actions/assignments';
import { getUsers } from '@/server/actions/users';
import { getContracts } from '@/server/actions/contracts';
import { listChargeCodes, getChargeCodeAssignments } from '@/server/actions/charge-codes';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { AssignmentsClient } from './AssignmentsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Assignments' };

export const dynamic = 'force-dynamic';

export default async function AssignmentsPage() {
  await requirePageRole('admin');

  const [assignments, allUsers, allContracts, allChargeCodes, chargeCodeAssignments, workspaceTimezone] = await Promise.all([
    getAssignments(),
    getUsers(),
    getContracts(),
    listChargeCodes(),
    getChargeCodeAssignments(),
    getWorkspaceTimezone(),
  ]);
  return (
    <AssignmentsClient
      initialAssignments={assignments}
      users={allUsers}
      contracts={allContracts}
      chargeCodes={allChargeCodes}
      initialChargeCodeAssignments={chargeCodeAssignments}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
