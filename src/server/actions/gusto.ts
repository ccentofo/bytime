'use server';

import { getDefaultSyncWindow } from '@/server/internal/workspace-settings';
import { requireAdminFresh } from '@/lib/session';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';
import type { CalendarDate } from '@/lib/calendar-date';
import { validateCalendarDate } from '@/lib/validation';
import { userAction } from '@/lib/action-result';

/**
 * Trigger a manual sync for a Gusto connection.
 *
 * feature-plan-ux-integrations-billing.md I10: the Gusto connector sends nothing to Gusto (it records payroll totals
 * locally), so the UI no longer offers a send, matching or the employee load. This action stays server-side, unused by
 * the UI.
 */
export async function triggerGustoSync(data: {
  connectionId: string;
  /** Omit both to use the default window, computed in the workspace's calendar. */
  periodStart?: CalendarDate;
  periodEnd?: CalendarDate;
}) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const window = data.periodStart && data.periodEnd
      // R4: user dates → a user-facing validation error, never parseCalendarDate's plain Error.
      ? { periodStart: validateCalendarDate(data.periodStart, 'Start date'), periodEnd: validateCalendarDate(data.periodEnd, 'End date') }
      : await getDefaultSyncWindow();
    return executeSyncOperation(
      data.connectionId,
      'timesheet_push',
      window.periodStart,
      window.periodEnd,
      actor.id,
      'manual'
    );
  });
}
