import { requirePageRole } from '@/lib/session';
import { getApiKeys } from '@/server/actions/api-keys';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { ApiKeysClient } from './ApiKeysClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'API keys' };

export const dynamic = 'force-dynamic';

export default async function ApiKeysPage() {
  await requirePageRole('admin');
  const [keys, workspaceTimezone] = await Promise.all([getApiKeys(), getWorkspaceTimezone()]);

  return <ApiKeysClient initialKeys={keys} workspaceTimezone={workspaceTimezone} />;
}
