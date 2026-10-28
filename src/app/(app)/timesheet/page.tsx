import { auth } from '@/auth';
import { loginRedirect } from '@/lib/session';
import { getTimesheetPeriod } from '@/server/actions/timesheet';
import { BiWeeklyTimesheetClient } from '@/components/timesheet/BiWeeklyTimesheetClient';
import type { TimesheetPageData } from '@/types/timesheet';
import { getUserByEmail } from '@/server/internal/users';
import { getEmployeeDashboardData } from '@/server/actions/employee-dashboard';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { getTenantState } from '@/lib/tenant/context';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Timesheet' };

export const dynamic = 'force-dynamic';

// Next 16: `searchParams` is a Promise and a value may be an array (feature-plan-ux-timesheet.md A4.6, trap T-G).
export default async function TimesheetPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return loginRedirect();
  }

  const userId = session.user.id;

  // `?period=` opens that period: getTimesheetPeriod snaps a mid-period date, clamps a future one and treats anything
  // else as the current period (resolveRequestedPeriod) — never an error page.
  const { period: requested } = await searchParams;
  const today = await getWorkspaceToday();

  // Fetch ALL independent data in parallel (single await). getTimesheetPeriod resolves the
  // period's length and schedule on the server, the same way navigation does.
  const [period, fullUser, dashboardData, tenantState] = await Promise.all([
    getTimesheetPeriod(requested),
    getUserByEmail(session.user.email!),
    getEmployeeDashboardData(),
    getTenantState(),
  ]);

  const pageData: TimesheetPageData = {
    userId,
    // certified-outputs C4: this period's code list (assignable ∪ codes with recorded hours, kind + assignable).
    chargeCodes: period.chargeCodes,
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
