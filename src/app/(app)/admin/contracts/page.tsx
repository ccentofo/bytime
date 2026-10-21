import { requirePageRole } from '@/lib/session';
import { getContracts } from '@/server/actions/contracts';
import { ContractsClient } from './ContractsClient';

export const dynamic = 'force-dynamic';

export default async function ContractsPage() {
  await requirePageRole('admin');

  const contracts = await getContracts();
  return <ContractsClient initialContracts={contracts} />;
}
