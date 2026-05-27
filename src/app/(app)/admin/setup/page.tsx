import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getSetupStatus } from '@/server/actions/setup';
import { SetupWizardClient } from './SetupWizardClient';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

  const setupStatus = await getSetupStatus();

  return <SetupWizardClient initialStatus={setupStatus} />;
}
