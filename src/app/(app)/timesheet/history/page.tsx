import { auth } from '@/auth';
import { loginRedirect } from '@/lib/session';
import { getPastTimesheets } from '@/server/actions/timesheet';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { PastTimesheetsClient } from './PastTimesheetsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Past timesheets' };

export const dynamic = 'force-dynamic';

// feature-plan-ux-timesheet-ui.md §4.11: page 0 is fetched here, so the list renders with the page; the client formats
// dates in the workspace timezone it's given (deterministic, no hydration mismatch).
export default async function PastTimesheetsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    return loginRedirect();
  }

  const [first, timeZone] = await Promise.all([getPastTimesheets({ page: 0 }), getWorkspaceTimezone()]);

  return <PastTimesheetsClient initial={first} timeZone={timeZone} />;
}
