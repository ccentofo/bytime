import { requirePageRole } from '@/lib/session';
import { getSetupAccessGaps, getSetupStatus } from '@/server/actions/setup';
import { SetupWizardClient } from './SetupWizardClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Setup' };

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  await requirePageRole('admin');

  const [setupStatus, accessGaps] = await Promise.all([getSetupStatus(), getSetupAccessGaps()]);

  return <SetupWizardClient initialStatus={setupStatus} initialGaps={accessGaps} />;
}
