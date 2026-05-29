'use server';

import { db } from '@/db';
import { integrationConnections, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { ensureValidGustoToken, fetchGustoEmployees } from '@/lib/integrations/connectors/gusto-api';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';

/**
 * Fetch Gusto employees for the mapping UI.
 */
export async function fetchGustoEmployeesForMapping(connectionId: string) {
  await requireAdmin();
  const accessToken = await ensureValidGustoToken(connectionId);

  const [connection] = await db
    .select({ externalCompanyId: integrationConnections.externalCompanyId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection?.externalCompanyId) throw new Error('Connection has no company ID.');

  return fetchGustoEmployees(accessToken, connection.externalCompanyId);
}

/**
 * Get ByTime employees for the mapping UI.
 */
export async function getBytimeEmployeesForGustoMapping() {
  await requireAdmin();
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
  periodStart: Date;
  periodEnd: Date;
  triggeredBy: string;
}) {
  await requireAdmin();
  return executeSyncOperation(
    data.connectionId,
    'timesheet_push',
    data.periodStart,
    data.periodEnd,
    data.triggeredBy,
    'manual'
  );
}
