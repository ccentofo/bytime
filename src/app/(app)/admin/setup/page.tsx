import { requirePageRole } from '@/lib/session';
import { getSetupStatus } from '@/server/actions/setup';
import { SetupWizardClient } from './SetupWizardClient';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  await requirePageRole('admin');

  const setupStatus = await getSetupStatus();

  return <SetupWizardClient initialStatus={setupStatus} />;
}
