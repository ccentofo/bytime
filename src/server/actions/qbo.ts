'use server';

import { getDb, getDbForWrite } from '@/db';
import { integrationConnections, users, contracts, clins, integrationEntityMappings } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { ensureValidToken, fetchQBOEmployees, fetchQBOCustomers, fetchQBOServiceItems, fetchQBOVendors, fetchQBOClasses } from '@/lib/integrations/connectors/qbo-api';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';
import { createCostClassInternal, createChargeCodeInternal, validateChargeCodeInput, validName } from '@/server/internal/charge-codes';
import type { CalendarDate } from '@/lib/calendar-date';
import { validateUUID } from '@/lib/validation';
import { safeErrorMessage } from '@/server/internal/import-errors';
import { INTEGRATION_DISCONNECTED_MESSAGE } from '@/lib/integrations/provider-errors';
import { payPeriodStartingOn } from '@/server/internal/integration-send';
import { UserFacingError } from '@/lib/errors';
import { userAction } from '@/lib/action-result';

/**
 * feature-plan-ux-integrations-billing.md I3: the QuickBooks lists for the matching tabs, loaded when the page opens.
 * ONE action, so the token is refreshed at most once per load. Refreshes across requests are serialized by
 * ensureValidToken (qbo-api.ts, launch hardening H6: the integration-token lock plus a re-read). The 4 queries then run with
 * Promise.allSettled: one failed list returns its own (safe) message and the others still load.
 */
/**
 * SWEEP-FINDINGS.md A3-D2 (lead, Q1): a refused QuickBooks import item's message names the item, e.g.
 * `"Senior Engineer": Choose an active CLIN.`
 */
async function withItemName<T>(name: unknown, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UserFacingError) {
      const label = typeof name === 'string' && name.trim() ? name.trim() : 'An item';
      throw new UserFacingError(`"${label}": ${err.message}`, err.code);
    }
    throw err;
  }
}

type QboList<T> = { ok: true; data: T[] } | { ok: false; error: string };

function settle<T>(result: PromiseSettledResult<T[]>): QboList<T> {
  if (result.status === 'fulfilled') return { ok: true, data: result.value };
  return { ok: false, error: safeErrorMessage(result.reason, { fallback: 'Couldn’t load this list from QuickBooks. Try again.', logLabel: 'QuickBooks list load failed:' }) };
}

export async function loadQboMappingData(connectionId: string) {
  return userAction(async () => {
    await requireAdminFresh();
    const id = validateUUID(connectionId, 'Connection');
    const db = await getDb();
    const [connection] = await db
      .select({ provider: integrationConnections.provider, isActive: integrationConnections.isActive, externalCompanyId: integrationConnections.externalCompanyId })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id))
      .limit(1);
    if (!connection || !connection.isActive || connection.provider !== 'quickbooks_online') throw new UserFacingError(INTEGRATION_DISCONNECTED_MESSAGE);
    if (!connection.externalCompanyId) throw new UserFacingError('Connection has no company ID.');
    const accessToken = await ensureValidToken(id);
    const realmId = connection.externalCompanyId;
    const [employees, vendors, customers, items] = await Promise.allSettled([
      fetchQBOEmployees(accessToken, realmId),
      fetchQBOVendors(accessToken, realmId),
      fetchQBOCustomers(accessToken, realmId),
      fetchQBOServiceItems(accessToken, realmId),
    ]);
    return { employees: settle(employees), vendors: settle(vendors), customers: settle(customers), items: settle(items) };
  });
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
 * Send one pay period's approved hours to QuickBooks (feature-plan-ux-integrations-billing.md I6). `periodStart` must
 * be a pay-period start; the server resolves its end. Refused while another send for the connection is running
 * (under 15 minutes old), checked and claimed under the send lock (executeSyncOperation `exclusive`).
 */
export async function triggerQBOSync(data: { connectionId: string; periodStart: CalendarDate }) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const connectionId = validateUUID(data?.connectionId, 'Connection');
    const db = await getDb();
    // UX-4C2B-AUDIT.md F8: only an active QuickBooks connection (a Gusto id would run Gusto's local-record path).
    const [connection] = await db
      .select({ provider: integrationConnections.provider, isActive: integrationConnections.isActive })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    if (!connection || !connection.isActive) throw new UserFacingError(INTEGRATION_DISCONNECTED_MESSAGE);
    if (connection.provider !== 'quickbooks_online') throw new UserFacingError('This isn’t a QuickBooks Online connection.');
    const period = await payPeriodStartingOn(db, data?.periodStart);
    return executeSyncOperation(connectionId, 'timesheet_push', period.start, period.end, actor.id, 'manual', { exclusive: true });
  });
}

/**
 * Fetch QBO Classes for the mapping/import UI.
 */
export async function fetchQBOClassesForMapping(connectionId: string) {
  return userAction(async () => {
    await requireAdminFresh();
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
  });
}

/**
 * Import QBO Classes as CadenzPoint cost_classes.
 * Idempotent: re-running updates mapping, doesn't duplicate.
 */
export async function importQboClasses(connectionId: string, selected: Array<{ qboId: string; name: string }>) {
  return userAction(async () => {
    await requireAdminFresh();
    const connId = validateUUID(connectionId, 'Connection');
    if (!Array.isArray(selected)) throw new UserFacingError('Choose the classes to import.');
    const db = await getDbForWrite();
    // SWEEP-FINDINGS.md A3-D2: every name validated, and the whole import in ONE transaction (all or nothing).
    return db.transaction(async (tx) => {
      let created = 0;
      let updated = 0;

      for (const item of selected) {
        const name = await withItemName(item?.name, () => validName(item?.name));
        const existing = await tx.select({ id: integrationEntityMappings.id, bytimeEntityId: integrationEntityMappings.bytimeEntityId })
          .from(integrationEntityMappings)
          .where(and(
            eq(integrationEntityMappings.connectionId, connId),
            eq(integrationEntityMappings.entityType, 'class'),
            eq(integrationEntityMappings.externalEntityId, item.qboId),
          )).limit(1);

        if (existing.length > 0) {
          updated++;
          continue; // already imported
        }

        // Create the cost class (idempotent via UNIQUE constraint on name)
        const costClass = await createCostClassInternal(tx, name);
        if (!costClass) continue;

        await tx.insert(integrationEntityMappings).values({
          connectionId: connId, entityType: 'class',
          bytimeEntityId: costClass.id,
          bytimeEntityName: costClass.name,
          externalEntityId: item.qboId,
          externalEntityName: item.name,
        });
        created++;
      }

      return { created, updated };
    });
  });
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
  return userAction(async () => {
    await requireAdminFresh();
    const connId = validateUUID(connectionId, 'Connection');
    if (!Array.isArray(items)) throw new UserFacingError('Choose the charge codes to import.');
    const db = await getDbForWrite();
    // SWEEP-FINDINGS.md A3-D2: each item through the same rules as createChargeCode (validateChargeCodeInput: lengths,
    // an active CLIN on an active contract, the work location), and the whole import in ONE transaction: the first
    // refused item, or a duplicate code, writes nothing at all. Errors name the QuickBooks item.
    return db.transaction(async (tx) => {
      let created = 0;
      let updated = 0;

      for (const item of items) {
        if (!item?.clinId) throw new UserFacingError(`Charge code "${item?.name}" requires a CLIN selection.`);

        const existing = await tx.select({ id: integrationEntityMappings.id, bytimeEntityId: integrationEntityMappings.bytimeEntityId })
          .from(integrationEntityMappings)
          .where(and(
            eq(integrationEntityMappings.connectionId, connId),
            eq(integrationEntityMappings.entityType, 'charge_code'),
            eq(integrationEntityMappings.externalEntityId, item.qboId),
          )).limit(1);

        if (existing.length > 0) {
          // Already imported — idempotent skip (could update name here if desired)
          updated++;
          continue;
        }

        // Use QBO item name as both code and human name (admin can edit later)
        const input = await withItemName(item.name, async () => {
          const code = typeof item.name === 'string' ? item.name.replace(/\s+/g, '-').substring(0, 100) : item.name;
          return validateChargeCodeInput(tx, {
            code, name: item.name,
            clinId: validateUUID(item.clinId, 'CLIN'),
            classId: item.classId === undefined || item.classId === null || item.classId === '' ? undefined : validateUUID(item.classId, 'Class'),
            workLocation: item.workLocation,
          });
        });
        const chargeCode = await createChargeCodeInternal(tx, input);
        if (!chargeCode) continue;

        await tx.insert(integrationEntityMappings).values({
          connectionId: connId, entityType: 'charge_code',
          bytimeEntityId: chargeCode.id,
          bytimeEntityName: chargeCode.name,
          externalEntityId: item.qboId,
          externalEntityName: item.name,
        });
        created++;
      }

      return { created, updated };
    });
  });
}
