import { requirePageRole } from '@/lib/session';
import { getIndirectChargeCodes } from '@/server/actions/indirect-codes';
import { IndirectCodesClient } from './IndirectCodesClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Indirect charge codes' };

export const dynamic = 'force-dynamic';

export default async function IndirectCodesPage() {
  await requirePageRole('admin');

  const codes = await getIndirectChargeCodes();

  return <IndirectCodesClient initialCodes={codes} />;
}
