import { redirect } from 'next/navigation';
import { requirePageRole } from '@/lib/session';
import { getDb } from '@/db';
import { getIntegrationHub, getMappings, getSyncLogs } from '@/server/actions/integrations';
import { getBytimeEmployeesForMapping, getBytimeContractsForMapping, getBytimeClinsForMapping } from '@/server/actions/qbo';
import { getWorkspaceTimezone, getWorkspaceToday } from '@/server/internal/workspace-settings';
import { loadScheduleResolver } from '@/server/internal/pay-period-config';
import { connectionExpiredError } from '@/lib/integrations/provider-errors';
import { addDays } from '@/lib/calendar-date';
import { periodLabel } from '@/lib/timesheet/labels';
import { IntegrationConfigView, type SendPeriodOption } from '../IntegrationConfigView';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'QuickBooks' };

export const dynamic = 'force-dynamic';

/**
 * The QuickBooks integration page (feature-plan-ux-integrations-billing.md §3.2). It always shows the single active
 * QuickBooks connection (I9); with none, back to the hub. The "Send hours now…" pay periods — last completed (the
 * default), this one and the two before — are resolved here from the schedule (I6).
 */
export default async function QBOConfigPage() {
  await requirePageRole('admin');

  const hub = await getIntegrationHub();
  const connection = hub.qbo;
  if (!connection) redirect('/settings/integrations');

  const [mappings, syncLogs, people, contracts, clins, workspaceTimezone, today] = await Promise.all([
    getMappings(connection.id),
    getSyncLogs(connection.id),
    getBytimeEmployeesForMapping(),
    getBytimeContractsForMapping(),
    getBytimeClinsForMapping(),
    getWorkspaceTimezone(),
    getWorkspaceToday(),
  ]);

  const schedule = await loadScheduleResolver(await getDb());
  const current = schedule.periodContaining(today);
  const last = schedule.neighbor(current.start, 'prev');
  const previous = schedule.neighbor(last.start, 'prev');
  const beforePrevious = schedule.neighbor(previous.start, 'prev');
  const option = (p: { start: typeof today; numDays: number }, name: string): SendPeriodOption => {
    const end = addDays(p.start, p.numDays - 1);
    return { start: p.start, end, label: `${name} · ${periodLabel(p.start, end)}` };
  };
  const periods = [
    option(last, 'Last pay period'),
    option(current, 'This pay period'),
    option(previous, 'Pay period'),
    option(beforePrevious, 'Pay period'),
  ];

  return (
    <IntegrationConfigView
      connection={{ id: connection.id, companyName: connection.companyName, connectedAt: connection.connectedAt, expired: connection.expired }}
      people={people}
      contracts={contracts}
      clins={clins}
      mappings={mappings}
      syncLogs={syncLogs}
      periods={periods}
      expiredMessage={connectionExpiredError('QuickBooks').message}
      workspaceTimezone={workspaceTimezone}
    />
  );
}
