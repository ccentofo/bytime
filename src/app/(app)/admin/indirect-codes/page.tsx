import { requirePageRole } from '@/lib/session';
import { getIndirectChargeCodes } from '@/server/actions/indirect-codes';
import { IndirectCodesClient } from './IndirectCodesClient';

export const dynamic = 'force-dynamic';

export default async function IndirectCodesPage() {
  await requirePageRole('admin');

  const codes = await getIndirectChargeCodes();

  return <IndirectCodesClient initialCodes={codes} />;
}
