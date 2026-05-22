import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getChargeCodesForUser, getTimesheetEntries, getRevisionMap } from '@/server/actions/timesheet';
import { getCurrentPeriodStart, getNumDaysInPeriod } from '@/lib/date-utils';
import { BiWeeklyTimesheetClient } from '@/components/timesheet/BiWeeklyTimesheetClient';
import type { TimesheetPageData } from '@/types/timesheet';
import { getPeriodStatus } from '@/server/actions/periods';

export const dynamic = 'force-dynamic';

export default async function TimesheetPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const userId = session.user.id;
  const periodStart = getCurrentPeriodStart();
  const numDays = getNumDaysInPeriod(periodStart);
  const chargeCodes = await getChargeCodesForUser(userId);
  const [entries, revisions, periodInfo] = await Promise.all([
    getTimesheetEntries(userId, periodStart, chargeCodes),
    getRevisionMap(userId, periodStart, numDays),
    getPeriodStatus(userId, periodStart),
  ]);

  const pageData: TimesheetPageData = {
    userId,
    chargeCodes,
    entries,
    periodStart,
    revisions,
    periodStatus: periodInfo.status,
  };

  return <BiWeeklyTimesheetClient initialData={pageData} />;
}
