import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getChargeCodesForUser, getTimesheetEntries, getRevisionMap } from '@/server/actions/timesheet';
import { getCurrentPeriodStart, getNumDaysInPeriod } from '@/lib/date-utils';
import { BiWeeklyTimesheetClient } from '@/components/timesheet/BiWeeklyTimesheetClient';
import type { TimesheetPageData } from '@/types/timesheet';
import { getPeriodStatus } from '@/server/actions/periods';
import { getUserByEmail } from '@/server/internal/users';
import { getEmployeeDashboardData } from '@/server/actions/employee-dashboard';
import { getCurrentEffectiveConfig, getEffectiveConfigAt } from '@/server/actions/pay-period-config';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';

export const dynamic = 'force-dynamic';

export default async function TimesheetPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const userId = session.user.id;

  // Use the config currently in effect to determine which period to land on
  const today = await getWorkspaceToday();
  const landingConfig = await getCurrentEffectiveConfig();
  const periodStart = getCurrentPeriodStart(today, landingConfig);

  // Resolve the config authoritative for this specific period start date
  // (may differ from landingConfig if a schedule change is pending)
  const periodConfig = await getEffectiveConfigAt(periodStart);
  const numDays = getNumDaysInPeriod(periodStart, periodConfig);

  // Fetch ALL independent data in parallel (single await)
  const [chargeCodes, revisions, periodInfo, fullUser, dashboardData] = await Promise.all([
    getChargeCodesForUser(),
    getRevisionMap(periodStart, numDays),
    getPeriodStatus(periodStart),
    getUserByEmail(session.user.email!),
    getEmployeeDashboardData(),
  ]);

  // Only this depends on chargeCodes — runs after the parallel batch
  const entries = await getTimesheetEntries(periodStart, chargeCodes);

  const pageData: TimesheetPageData = {
    userId,
    chargeCodes,
    entries,
    periodStart,
    today,
    revisions,
    periodStatus: periodInfo.status,
    flsaExempt: fullUser?.flsaExempt ?? false,
    dashboardData,
    periodConfig,
  };

  return <BiWeeklyTimesheetClient initialData={pageData} />;
}
