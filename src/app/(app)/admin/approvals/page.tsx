import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getScopedPeriods } from '@/server/actions/periods';
import { getSupervisedEmployeeIds, getSupervisorScopeInfo } from '@/server/actions/supervisor-scope';
import { ApprovalsClient } from './ApprovalsClient';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const userId = session.user.id!;

  // Get supervisor's scope
  const scopedEmployeeIds = await getSupervisedEmployeeIds(userId, role);

  // Parallel fetch: periods + scope info (scope info is independent of periods)
  const [periods, scopeInfo] = await Promise.all([
    getScopedPeriods(scopedEmployeeIds),
    role === 'supervisor'
      ? getSupervisorScopeInfo(userId)
      : Promise.resolve(null),
  ]);

  return (
    <ApprovalsClient
      initialPeriods={periods}
      currentUserId={userId}
      userRole={role}
      scopeInfo={scopeInfo}
    />
  );
}
