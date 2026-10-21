import { requirePageRole } from '@/lib/session';
import { getApiKeys } from '@/server/actions/api-keys';
import { ApiKeysClient } from './ApiKeysClient';

export const dynamic = 'force-dynamic';

export default async function ApiKeysPage() {
  await requirePageRole('admin');
  const keys = await getApiKeys();

  return <ApiKeysClient initialKeys={keys} />;
}
