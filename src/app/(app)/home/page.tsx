import { redirect } from 'next/navigation';
import { requirePageRole } from '@/lib/session';
import { getHomeData } from '@/server/internal/home';
import { HomeClient } from './HomeClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Home' };

export const dynamic = 'force-dynamic';

/** Home (feature-plan-ux-navigation-home.md §4.5, UX-D3): where admins and supervisors land. */
export default async function HomePage() {
  const user = await requirePageRole('approver');
  const data = await getHomeData(user.id);
  // The role comes from fresh DB facts: someone demoted or deactivated within the JWT window goes to the timesheet.
  if ('redirect' in data) redirect(data.redirect);
  return <HomeClient view={data} />;
}
