'use server';

import { getDefaultSyncWindow } from '@/server/internal/workspace-settings';
import { getDb } from '@/db';
import { integrationConnections, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { ensureValidGustoToken, fetchGustoEmployees } from '@/lib/integrations/connectors/gusto-api';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';
import type { CalendarDate } from '@/lib/calendar-date';
import { validateCalendarDate } from '@/lib/validation';
import { UserFacingError } from '@/lib/errors';
import { userAction } from '@/lib/action-result';

/**
 * Fetch Gusto employees for the mapping UI.
 */
export async function fetchGustoEmployeesForMapping(connectionId: string) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDb();
    const accessToken = await ensureValidGustoToken(connectionId);

    const [connection] = await db
      .select({ externalCompanyId: integrationConnections.externalCompanyId })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));

    if (!connection?.externalCompanyId) throw new UserFacingError('Connection has no company ID.');

    return fetchGustoEmployees(accessToken, connection.externalCompanyId);
  });
}

/**
 * Get ByTime employees for the mapping UI.
 */
export async function getBytimeEmployeesForGustoMapping() {
  await requireAdmin();
  const db = await getDb();
  return db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(users.fullName);
}

/**
 * Trigger a manual sync for a Gusto connection.
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
