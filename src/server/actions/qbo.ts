'use server';

import { getDefaultSyncWindow } from '@/server/internal/workspace-settings';
import { getDb } from '@/db';
import { integrationConnections, users, contracts, clins, integrationEntityMappings } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { decrypt } from '@/lib/encryption';
import { ensureValidToken, fetchQBOEmployees, fetchQBOCustomers, fetchQBOServiceItems, fetchQBOVendors, fetchQBOClasses } from '@/lib/integrations/connectors/qbo-api';
import { getMappings } from '@/server/actions/integrations';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';
import { createCostClass, createChargeCode } from '@/server/actions/charge-codes';
import { parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';

/**
 * Fetch QBO employees for the mapping UI.
 * Automatically refreshes the token if needed.
 */
export async function fetchQBOEmployeesForMapping(connectionId: string) {
  await requireAdmin();
  const db = await getDb();
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
  const db = await getDb();
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
  const db = await getDb();
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
  const db = await getDb();
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
  const db = await getDb();
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
  const db = await getDb();
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
  const db = await getDb();
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
  /** Omit both to use the default window, computed in the workspace's calendar. */
  periodStart?: CalendarDate;
  periodEnd?: CalendarDate;
}) {
  const actor = await requireAdmin();
  const window = data.periodStart && data.periodEnd
    ? { periodStart: parseCalendarDate(data.periodStart), periodEnd: parseCalendarDate(data.periodEnd) }
    : await getDefaultSyncWindow();
  return executeSyncOperation(
    data.connectionId,
    'timesheet_push',
    window.periodStart,
    window.periodEnd,
    actor.id,
    'manual'
  );
}

/**
 * Fetch QBO Classes for the mapping/import UI.
 */
export async function fetchQBOClassesForMapping(connectionId: string) {
  await requireAdmin();
  const db = await getDb();
  const accessToken = await ensureValidToken(connectionId);
  const [connection] = await db
    .select({ externalCompanyId: integrationConnections.externalCompanyId })
    .from(integrationConnections).where(eq(integrationConnections.id, connectionId)).limit(1);
  const realmId = connection?.externalCompanyId ?? '';

  const classes = await fetchQBOClasses(accessToken, realmId);

  // Annotate with existing mappings
  const mappingRows = await db.select()
    .from(integrationEntityMappings)
    .where(and(eq(integrationEntityMappings.connectionId, connectionId), eq(integrationEntityMappings.entityType, 'class')));
  const mapped = new Set(mappingRows.map((m) => m.externalEntityId));

  return classes.map((c) => ({ id: c.Id, name: c.Name, fullyQualifiedName: c.FullyQualifiedName, alreadyMapped: mapped.has(c.Id) }));
}

/**
 * Import QBO Classes as CadenzPoint cost_classes.
 * Idempotent: re-running updates mapping, doesn't duplicate.
 */
export async function importQboClasses(connectionId: string, selected: Array<{ qboId: string; name: string }>) {
  await requireAdmin();
  const db = await getDb();
  let created = 0;
  let updated = 0;

  for (const item of selected) {
    const existing = await db.select({ id: integrationEntityMappings.id, bytimeEntityId: integrationEntityMappings.bytimeEntityId })
      .from(integrationEntityMappings)
      .where(and(
        eq(integrationEntityMappings.connectionId, connectionId),
        eq(integrationEntityMappings.entityType, 'class'),
        eq(integrationEntityMappings.externalEntityId, item.qboId),
      )).limit(1);

    if (existing.length > 0) {
      updated++;
      continue; // already imported
    }

    // Create the cost class (idempotent via UNIQUE constraint on name)
    const costClass = await createCostClass(item.name);
    if (!costClass) continue;

    await db.insert(integrationEntityMappings).values({
      connectionId, entityType: 'class',
      bytimeEntityId: costClass.id,
      bytimeEntityName: costClass.name,
      externalEntityId: item.qboId,
      externalEntityName: item.name,
    });
    created++;
  }

  return { created, updated };
}

/**
 * Import QBO Service Items as CadenzPoint charge_codes.
 * Each item must be assigned to a CLIN. Idempotent via charge_code mapping.
 */
export async function importQboChargeCodes(
  connectionId: string,
  items: Array<{
    qboId: string;
    name: string;
    clinId: string;           // resolved by admin
    classId?: string;         // optional: from imported classes
    workLocation?: 'onsite' | 'telework' | 'other';
  }>
) {
  await requireAdmin();
  const db = await getDb();
  let created = 0;
  let updated = 0;

  for (const item of items) {
    if (!item.clinId) throw new Error(`Charge code "${item.name}" requires a CLIN selection.`);

    const existing = await db.select({ id: integrationEntityMappings.id, bytimeEntityId: integrationEntityMappings.bytimeEntityId })
      .from(integrationEntityMappings)
      .where(and(
        eq(integrationEntityMappings.connectionId, connectionId),
        eq(integrationEntityMappings.entityType, 'charge_code'),
        eq(integrationEntityMappings.externalEntityId, item.qboId),
      )).limit(1);

    if (existing.length > 0) {
      // Already imported — idempotent skip (could update name here if desired)
      updated++;
      continue;
    }

    // Use QBO item name as both code and human name (admin can edit later)
    const code = item.name.replace(/\s+/g, '-').substring(0, 100);
    const chargeCode = await createChargeCode({
      code, name: item.name, clinId: item.clinId,
      classId: item.classId ?? undefined, workLocation: item.workLocation,
    });
    if (!chargeCode) continue;

    await db.insert(integrationEntityMappings).values({
      connectionId, entityType: 'charge_code',
      bytimeEntityId: chargeCode.id,
      bytimeEntityName: chargeCode.name,
      externalEntityId: item.qboId,
      externalEntityName: item.name,
    });
    created++;
  }

  return { created, updated };
}
