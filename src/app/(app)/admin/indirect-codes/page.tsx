import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getIndirectChargeCodes } from '@/server/actions/indirect-codes';
import { IndirectCodesClient } from './IndirectCodesClient';

export const dynamic = 'force-dynamic';

export default async function IndirectCodesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const codes = await getIndirectChargeCodes();

  return <IndirectCodesClient initialCodes={codes} />;
}
