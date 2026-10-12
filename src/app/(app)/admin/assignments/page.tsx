import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getAssignments } from '@/server/actions/assignments';
import { getUsers } from '@/server/actions/users';
import { getContracts } from '@/server/actions/contracts';
import { listChargeCodes, getChargeCodeAssignments } from '@/server/actions/charge-codes';
import { AssignmentsClient } from './AssignmentsClient';

export const dynamic = 'force-dynamic';

export default async function AssignmentsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const [assignments, allUsers, allContracts, allChargeCodes, chargeCodeAssignments] = await Promise.all([
    getAssignments(),
    getUsers(),
    getContracts(),
    listChargeCodes(),
    getChargeCodeAssignments(),
  ]);
  return (
    <AssignmentsClient
      initialAssignments={assignments}
      users={allUsers}
      contracts={allContracts}
      chargeCodes={allChargeCodes}
      initialChargeCodeAssignments={chargeCodeAssignments}
    />
  );
}
