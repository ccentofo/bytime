import { auth } from '@/auth';
import { loginRedirect } from '@/lib/session';
import { getTimesheetPeriod } from '@/server/actions/timesheet';
import { TimesheetClient } from '@/components/timesheet/TimesheetClient';
import type { TimesheetPageData } from '@/types/timesheet';
import { getUserByEmail } from '@/server/internal/users';
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

  // Fetch ALL independent data in parallel (single await). getTimesheetPeriod resolves the
  // period's length and schedule on the server, the same way navigation does.
  const [period, fullUser] = await Promise.all([
    getTimesheetPeriod(requested),
    getUserByEmail(session.user.email!),
  ]);

  // feature-plan-ux-timesheet-ui.md §4.4: the page context plus the whole period. `today` and `readOnly` come from the
  // period load (getTimesheetPeriod computes them), never a second read.
  const pageData: TimesheetPageData = {
    userId,
    today: period.today,
    readOnly: period.readOnly,
    flsaExempt: fullUser?.flsaExempt ?? false,
    period,
  };

  return <TimesheetClient initialData={pageData} />;
}
