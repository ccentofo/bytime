import { requirePageRole } from '@/lib/session';
import { getTenantBillingInfo } from '@/server/actions/billing';
import { BillingClient } from './BillingClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Billing' };

export const dynamic = 'force-dynamic';

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requirePageRole('admin');

  const { status } = await searchParams;
  const billing = await getTenantBillingInfo();

  return <BillingClient billing={billing} checkoutStatus={status} />;
}
