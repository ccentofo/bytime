import { requirePageRole } from '@/lib/session';
import { getCurrentEffectiveConfig, getPendingConfigChange } from '@/server/actions/pay-period-config';
import { PayScheduleClient } from './PayScheduleClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Pay schedule' };

export const dynamic = 'force-dynamic';

export default async function PaySchedulePage() {
  await requirePageRole('admin');

  const [config, pendingChange] = await Promise.all([
    getCurrentEffectiveConfig(),
    getPendingConfigChange(),
  ]);

  return <PayScheduleClient initialConfig={config} pendingChange={pendingChange} />;
}
