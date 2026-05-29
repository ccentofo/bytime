'use server';

import { db } from '@/db';
import { integrationConnections, users, contracts, clins } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { decrypt } from '@/lib/encryption';
import { ensureValidToken, getQBOAuthUrl, fetchQBOEmployees, fetchQBOCustomers, fetchQBOServiceItems, fetchQBOVendors } from '@/lib/integrations/connectors/qbo-api';
import { getMappings } from '@/server/actions/integrations';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';

/**
 * Get the QBO OAuth authorization URL for initiating the connection.
 */
export async function getQBOConnectUrl(): Promise<string> {
  await requireAdmin();
  return getQBOAuthUrl();
}

/**
 * Fetch QBO employees for the mapping UI.
 * Automatically refreshes the token if needed.
 */
export async function fetchQBOEmployeesForMapping(connectionId: string) {
  await requireAdmin();
  const accessToken = await ensureValidToken(connectionId);

  const [connection] = await db
    .select({ externalCompanyId: integrationConnections.externalCompanyId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection?.externalCompanyId) throw new Error('Connection has no company ID.');

  return fetchQBOEmployees(accessToken, connection.externalCompanyId);
}

/**
 * Fetch QBO customers for the mapping UI.
 */
export async function fetchQBOCustomersForMapping(connectionId: string) {
  await requireAdmin();
  const accessToken = await ensureValidToken(connectionId);

  const [connection] = await db
    .select({ externalCompanyId: integrationConnections.externalCompanyId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection?.externalCompanyId) throw new Error('Connection has no company ID.');

  return fetchQBOCustomers(accessToken, connection.externalCompanyId);
}

/**
 * Fetch QBO service items for the mapping UI.
 */
export async function fetchQBOServiceItemsForMapping(connectionId: string) {
  await requireAdmin();
  const accessToken = await ensureValidToken(connectionId);

  const [connection] = await db
    .select({ externalCompanyId: integrationConnections.externalCompanyId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection?.externalCompanyId) throw new Error('Connection has no company ID.');

  return fetchQBOServiceItems(accessToken, connection.externalCompanyId);
}

/**
 * Get ByTime employees for the mapping UI.
 */
export async function getBytimeEmployeesForMapping() {
  await requireAdmin();
  return db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(users.fullName);
}

/**
 * Get ByTime contracts for the mapping UI.
 */
export async function getBytimeContractsForMapping() {
  await requireAdmin();
  return db
    .select({
      id: contracts.id,
      contractNumber: contracts.contractNumber,
      name: contracts.name,
    })
    .from(contracts)
    .where(eq(contracts.status, 'active'))
    .orderBy(contracts.name);
}

/**
 * Get ByTime CLINs for the mapping UI.
 */
export async function getBytimeClinsForMapping() {
  await requireAdmin();
  return db
    .select({
      id: clins.id,
      clinNumber: clins.clinNumber,
      description: clins.description,
      contractId: clins.contractId,
    })
    .from(clins)
    .where(eq(clins.status, 'active'))
    .orderBy(clins.clinNumber);
}

/**
 * Fetch QBO vendors for the mapping UI.
 * Automatically refreshes the token if needed.
 */
export async function fetchQBOVendorsForMapping(connectionId: string) {
  await requireAdmin();
  const accessToken = await ensureValidToken(connectionId);

  const [connection] = await db
    .select({ externalCompanyId: integrationConnections.externalCompanyId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection?.externalCompanyId) throw new Error('Connection has no company ID.');

  return fetchQBOVendors(accessToken, connection.externalCompanyId);
}

/**
 * Trigger a manual sync for a QBO connection.
 */
export async function triggerQBOSync(data: {
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
