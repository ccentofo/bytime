import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getTenantBillingInfo } from '@/server/actions/billing';
import { BillingClient } from './BillingClient';

export const dynamic = 'force-dynamic';

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

  const { status } = await searchParams;
  const billing = await getTenantBillingInfo();

  return <BillingClient billing={billing} checkoutStatus={status} />;
}
