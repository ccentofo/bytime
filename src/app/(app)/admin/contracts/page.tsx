import { requirePageRole } from '@/lib/session';
import { getContractsOverview } from '@/server/actions/contracts';
import { ContractsClient } from './ContractsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Contracts and CLINs' };

export const dynamic = 'force-dynamic';

/**
 * Contracts and CLINs (feature-plan-ux-kit-contracts.md §4.1, C1): the former Overview (/admin/dashboard, now a redirect)
 * merged in. No ApprovalNotices here — Home shows the self-approval item.
 */
export default async function ContractsPage() {
  await requirePageRole('admin');
  const overview = await getContractsOverview();
  return <ContractsClient overview={overview} />;
}
