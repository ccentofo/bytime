import { requirePageRole } from '@/lib/session';
import { getIntegrationHub } from '@/server/actions/integrations';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { IntegrationsClient } from './IntegrationsClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Integrations' };

export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * The Integrations hub (feature-plan-ux-integrations-billing.md §3.1). I1: the OAuth callback's result
 * (`connected` / `provider` / `error`) is read HERE and passed as props — the client only drops the params from the URL
 * (replaceState syncs useSearchParams, so a banner read from it would vanish).
 */
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string | string[]; provider?: string | string[]; error?: string | string[] }>;
}) {
  await requirePageRole('admin');
  const params = await searchParams;
  const [hub, workspaceTimezone] = await Promise.all([getIntegrationHub(), getWorkspaceTimezone()]);
  return (
    <IntegrationsClient
      hub={hub}
      callback={{ connected: one(params.connected), provider: one(params.provider), error: one(params.error) }}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
