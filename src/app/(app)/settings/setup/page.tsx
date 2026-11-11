import type { Metadata } from 'next';
import { requirePageRole } from '@/lib/session';
import { getSetupPageData } from '@/server/actions/setup';
import { SetupChecklistClient } from './SetupChecklistClient';

export const metadata: Metadata = { title: 'Setup checklist' };

export const dynamic = 'force-dynamic';

/** The Setup checklist (feature-plan-ux-setup-import.md P1, §3.3): the first item in Settings. */
export default async function SetupChecklistPage() {
  await requirePageRole('admin');
  return <SetupChecklistClient initialData={await getSetupPageData()} />;
}
