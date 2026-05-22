import { getContracts } from '@/server/actions/contracts';
import { ContractsClient } from './ContractsClient';

export const dynamic = 'force-dynamic';

export default async function ContractsPage() {
  const contracts = await getContracts();
  return <ContractsClient initialContracts={contracts} />;
}
