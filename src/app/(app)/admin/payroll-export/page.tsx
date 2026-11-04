import { requirePageRole } from '@/lib/session';
import { PayrollExportClient, type PayrollPresets } from './PayrollExportClient';
import { getWorkspaceTimezone, getWorkspaceToday } from '@/server/internal/workspace-settings';
import { loadScheduleResolver } from '@/server/internal/pay-period-config';
import { getPayrollExportPreview } from '@/server/actions/payroll-export';
import { getDb } from '@/db';
import { addDays } from '@/lib/calendar-date';
import { periodLabel } from '@/lib/timesheet/labels';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Payroll export' };

export const dynamic = 'force-dynamic';

/**
 * Payroll export (feature-plan-ux-approvals-payroll.md §4): the presets — last (the default), this and the previous pay
 * period — are resolved here from the schedule, and the default range's preview is computed here too, so the page
 * opens with it (no mount effect).
 */
export default async function PayrollExportPage() {
  await requirePageRole('admin');
  const [today, timeZone] = await Promise.all([getWorkspaceToday(), getWorkspaceTimezone()]);
  const schedule = await loadScheduleResolver(await getDb());
  const current = schedule.periodContaining(today);
  const last = schedule.neighbor(current.start, 'prev');
  const previous = schedule.neighbor(last.start, 'prev');
  const range = (p: { start: typeof today; numDays: number }) => {
    const end = addDays(p.start, p.numDays - 1);
    return { start: p.start, end, label: periodLabel(p.start, end) };
  };
  const presets: PayrollPresets = { last: range(last), current: range(current), previous: range(previous) };
  const initialPreview = await getPayrollExportPreview({ periodStart: presets.last.start, periodEnd: presets.last.end });

  return <PayrollExportClient presets={presets} initialPreview={initialPreview} timeZone={timeZone} />;
}
