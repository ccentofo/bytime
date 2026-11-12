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
  const callback = { connected: one(params.connected), provider: one(params.provider), error: one(params.error) };
  return (
    <IntegrationsClient
      // Launch hardening H5: the banner is mount-only state. Connect is now a server action whose redirect back here is
      // a soft navigation, so a new callback result must remount the client for its banner to show.
      key={`${callback.error ?? ''}|${callback.connected ?? ''}|${callback.provider ?? ''}`}
      hub={hub}
      callback={callback}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
