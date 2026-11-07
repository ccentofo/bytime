import {
  getAdminChanges, getAuditEntries, getAuditPeriodEvents, getAuditSummary, getClinsForFilter, getContractsForFilter, getUsersForFilter,
} from '@/server/actions/audit';
import { resolvePeriodRange } from '@/server/actions/periods';
import { getWorkspaceTimezone, getWorkspaceToday } from '@/server/internal/workspace-settings';
import { AuditTrailClient, type AuditData, type ResolvedAuditRange } from './AuditTrailClient';
import { requirePageRole } from '@/lib/session';
import { firstParam } from '@/lib/assignments-params';
import { last30Days, parseAuditParams } from '@/lib/audit/audit-params';
import { isBefore } from '@/lib/calendar-date';
import { periodLabel } from '@/lib/timesheet/labels';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Audit trail' };

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Audit trail (feature-plan-ux-people-codes.md §6): the page server-loads what the URL asks for — the range resolved to
 * dates (default the last 30 workspace days), the filters, the tab and the page — so the first paint shows data.
 */
export default async function AuditTrailPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePageRole('approver');
  const isAdmin = user.role === 'admin';
  const sp = await searchParams;
  const params = parseAuditParams((k) => firstParam(sp[k]), { isAdmin });

  const [contractsList, usersList, workspaceTimezone, workspaceToday, clins] = await Promise.all([
    getContractsForFilter(),
    getUsersForFilter(),
    getWorkspaceTimezone(),
    getWorkspaceToday(),
    params.contract ? getClinsForFilter(params.contract) : Promise.resolve([]),
  ]);

  let range: ResolvedAuditRange | null = null;
  if (params.range === 'last30') {
    const r = last30Days(workspaceToday);
    range = { ...r, label: `Last 30 days · ${periodLabel(r.start, r.end)}` };
  } else if (params.range === 'custom') {
    if (params.start && params.end && !isBefore(params.end, params.start)) range = { start: params.start, end: params.end, label: periodLabel(params.start, params.end) };
  } else {
    const r = await resolvePeriodRange({ kind: params.range === 'last' ? 'lastPeriod' : 'thisPeriod' });
    if (r.ok && r.data.start && r.data.end) range = { start: r.data.start, end: r.data.end, label: r.data.label };
  }

  const data: AuditData = {};
  if (range) {
    const filters = {
      userId: params.user ?? undefined, contractId: params.contract ?? undefined, clinId: params.clin ?? undefined,
      reasonCode: params.reason ?? undefined, revisionsOnly: params.changed || undefined, startDate: range.start, endDate: range.end,
    };
    if (params.tab === 'entries') {
      const [entries, summary] = await Promise.all([getAuditEntries({ ...filters, page: params.page }), getAuditSummary(filters)]);
      data.entries = entries;
      data.summary = summary;
    } else if (params.tab === 'events') {
      data.events = await getAuditPeriodEvents({ userId: filters.userId, startDate: range.start, endDate: range.end });
    } else {
      data.admin = await getAdminChanges({ start: range.start, end: range.end, page: params.page });
    }
  }

  return (
    <AuditTrailClient
      initialParams={params}
      initialRange={range}
      initialData={data}
      contracts={contractsList}
      users={usersList}
      initialClins={clins}
      workspaceTimezone={workspaceTimezone}
      workspaceToday={workspaceToday}
      isAdmin={isAdmin}
    />
  );
}
