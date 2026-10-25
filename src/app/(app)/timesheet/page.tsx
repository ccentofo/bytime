import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getChargeCodesForUser, getTimesheetPeriod } from '@/server/actions/timesheet';
import { getCurrentPeriodStart } from '@/lib/date-utils';
import { BiWeeklyTimesheetClient } from '@/components/timesheet/BiWeeklyTimesheetClient';
import type { TimesheetPageData } from '@/types/timesheet';
import { getUserByEmail } from '@/server/internal/users';
import { getEmployeeDashboardData } from '@/server/actions/employee-dashboard';
import { getCurrentEffectiveConfig } from '@/server/actions/pay-period-config';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { getTenantState } from '@/lib/tenant/context';

export const dynamic = 'force-dynamic';

export default async function TimesheetPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const userId = session.user.id;

  // Land on the period containing the workspace's today, under the schedule in effect today.
  const today = await getWorkspaceToday();
  const periodStart = getCurrentPeriodStart(today, await getCurrentEffectiveConfig());

  // Fetch ALL independent data in parallel (single await). getTimesheetPeriod resolves the
  // period's length and schedule on the server, the same way navigation does.
  const [chargeCodes, period, fullUser, dashboardData, tenantState] = await Promise.all([
    getChargeCodesForUser(),
    getTimesheetPeriod(periodStart),
    getUserByEmail(session.user.email!),
    getEmployeeDashboardData(),
    getTenantState(),
  ]);

  const pageData: TimesheetPageData = {
    userId,
    chargeCodes,
    entries: period.entries,
    periodStart: period.periodStart,
    numDays: period.numDays,
    today,
    revisions: period.revisions,
    periodStatus: period.periodStatus,
    approvalBadge: period.approvalBadge,
    flsaExempt: fullUser?.flsaExempt ?? false,
    dashboardData,
    periodConfig: period.periodConfig,
    readOnly: tenantState.kind === 'read_only',
  };

  return <BiWeeklyTimesheetClient initialData={pageData} />;
}
