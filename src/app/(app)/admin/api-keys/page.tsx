import { requirePageRole } from '@/lib/session';
import { getApiKeys } from '@/server/actions/api-keys';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { ApiKeysClient } from './ApiKeysClient';

export const dynamic = 'force-dynamic';

export default async function ApiKeysPage() {
  await requirePageRole('admin');
  const [keys, workspaceTimezone] = await Promise.all([getApiKeys(), getWorkspaceTimezone()]);

  return <ApiKeysClient initialKeys={keys} workspaceTimezone={workspaceTimezone} />;
}
