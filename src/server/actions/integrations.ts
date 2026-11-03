'use server';

import { getDb, getDbForWrite } from '@/db';
import {
  integrationConnections,
  integrationEntityMappings,
  integrationSyncLogs,
  integrationSyncRecords,
} from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { decrypt } from '@/lib/encryption';
import { getAllConnectorMetadata } from '@/lib/integrations/registry';
import type { CalendarDate } from '@/lib/calendar-date';
import { userAction } from '@/lib/action-result';
import { validateUUID } from '@/lib/validation';
import { UserFacingError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// Connection Management
// ---------------------------------------------------------------------------

export async function getConnections() {
  const db = await getDb();
  await requireAdmin();
  return db
    .select({
      id: integrationConnections.id,
      provider: integrationConnections.provider,
      displayName: integrationConnections.displayName,
      externalCompanyName: integrationConnections.externalCompanyName,
      isActive: integrationConnections.isActive,
      autoSyncOnApproval: integrationConnections.autoSyncOnApproval,
      lastSyncAt: integrationConnections.lastSyncAt,
      lastSyncStatus: integrationConnections.lastSyncStatus,
      connectedAt: integrationConnections.connectedAt,
    })
    .from(integrationConnections)
    .orderBy(integrationConnections.createdAt);
}

export async function disconnectIntegration(connectionId: string) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    await db.update(integrationConnections)
      .set({
        isActive: false,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connectionId));
  });
}

export async function toggleAutoSync(connectionId: string, enabled: boolean) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    await db.update(integrationConnections)
      .set({
        autoSyncOnApproval: enabled,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connectionId));
  });
}

// ---------------------------------------------------------------------------
// Entity Mapping
// ---------------------------------------------------------------------------

export async function getMappings(connectionId: string) {
  const db = await getDb();
  await requireAdmin();
  return db
    .select()
    .from(integrationEntityMappings)
    .where(eq(integrationEntityMappings.connectionId, connectionId))
    .orderBy(integrationEntityMappings.entityType, integrationEntityMappings.bytimeEntityName);
}

export async function saveMapping(data: {
  connectionId: string;
  entityType: string;
  bytimeEntityId: string;
  bytimeEntityName: string;
  externalEntityId: string;
  externalEntityName: string;
  metadata?: string;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();

    // feature-plan-ux-page-fixes.md C13: one atomic upsert on mapping_unique_idx (connection, entity type, CadenzPoint
    // id), so two saves can't race into a unique violation; the caller gets the row's real id.
    const [row] = await db.insert(integrationEntityMappings)
      .values({
        connectionId: data.connectionId,
        entityType: data.entityType,
        bytimeEntityId: data.bytimeEntityId,
        bytimeEntityName: data.bytimeEntityName,
        externalEntityId: data.externalEntityId,
        externalEntityName: data.externalEntityName,
        metadata: data.metadata,
      })
      .onConflictDoUpdate({
        target: [integrationEntityMappings.connectionId, integrationEntityMappings.entityType, integrationEntityMappings.bytimeEntityId],
        set: {
          externalEntityId: data.externalEntityId,
          externalEntityName: data.externalEntityName,
          bytimeEntityName: data.bytimeEntityName,
          metadata: data.metadata,
          updatedAt: new Date(),
        },
      })
      .returning({ id: integrationEntityMappings.id });
    return { id: row.id };
  });
}

export async function deleteMapping(mappingId: string) {
  return userAction(async () => {
    await requireAdminFresh();
    validateUUID(mappingId, 'Mapping');
    const db = await getDbForWrite();
    const deleted = await db.delete(integrationEntityMappings).where(eq(integrationEntityMappings.id, mappingId)).returning({ id: integrationEntityMappings.id });
    if (deleted.length === 0) throw new UserFacingError('That mapping no longer exists.');
  });
}

// ---------------------------------------------------------------------------
// Sync Logs
// ---------------------------------------------------------------------------

export type SyncLog = Omit<typeof integrationSyncLogs.$inferSelect, 'periodStart' | 'periodEnd'> & {
  periodStart: CalendarDate | null;
  periodEnd: CalendarDate | null;
};

export async function getSyncLogs(connectionId: string, limit = 20): Promise<SyncLog[]> {
  const db = await getDb();
  await requireAdmin();
  const rows = await db
    .select()
    .from(integrationSyncLogs)
    .where(eq(integrationSyncLogs.connectionId, connectionId))
    .orderBy(desc(integrationSyncLogs.createdAt))
    .limit(limit);
  return rows as SyncLog[];
}

export async function getSyncRecords(syncLogId: string) {
  const db = await getDb();
  await requireAdmin();
  return db
    .select()
    .from(integrationSyncRecords)
    .where(eq(integrationSyncRecords.syncLogId, syncLogId))
    .orderBy(integrationSyncRecords.createdAt);
}

// ---------------------------------------------------------------------------
// Connector Registry (for UI)
// ---------------------------------------------------------------------------

export async function getAvailableConnectors() {
  await requireAdmin();
  return getAllConnectorMetadata();
}
