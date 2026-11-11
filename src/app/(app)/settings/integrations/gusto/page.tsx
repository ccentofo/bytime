import { redirect } from 'next/navigation';
import { requirePageRole } from '@/lib/session';
import { getIntegrationHub } from '@/server/actions/integrations';
import { GustoConfigClient } from './GustoConfigClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Gusto' };

export const dynamic = 'force-dynamic';

/**
 * An existing Gusto connection (feature-plan-ux-integrations-billing.md I10): the connector sends nothing to Gusto, so
 * the page shows only that note, "Open Payroll export" and Disconnect — no matching, sending or history.
 */
export default async function GustoConfigPage() {
  await requirePageRole('admin');
  const { gusto } = await getIntegrationHub();
  if (!gusto) redirect('/settings/integrations');
  return <GustoConfigClient connection={{ id: gusto.id, companyName: gusto.companyName }} />;
}
