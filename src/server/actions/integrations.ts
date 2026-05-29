'use server';

import { db } from '@/db';
import {
  integrationConnections,
  integrationEntityMappings,
  integrationSyncLogs,
  integrationSyncRecords,
} from '@/db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { encrypt, decrypt } from '@/lib/encryption';
import { getAllConnectorMetadata } from '@/lib/integrations/registry';

// ---------------------------------------------------------------------------
// Connection Management
// ---------------------------------------------------------------------------

export async function getConnections() {
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

export async function createConnection(data: {
  provider: string;
  displayName: string;
  externalCompanyId?: string;
  externalCompanyName?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  scopes?: string;
  connectedBy: string;
}) {
  await requireAdmin();

  const values: Record<string, unknown> = {
    provider: data.provider,
    displayName: data.displayName,
    externalCompanyId: data.externalCompanyId,
    externalCompanyName: data.externalCompanyName,
    scopes: data.scopes,
    connectedBy: data.connectedBy,
    tokenExpiresAt: data.tokenExpiresAt,
  };

  if (data.accessToken) {
    values.accessTokenEncrypted = encrypt(data.accessToken);
  }
  if (data.refreshToken) {
    values.refreshTokenEncrypted = encrypt(data.refreshToken);
  }

  const rows = await db.insert(integrationConnections).values(values as any).returning();
  return rows[0];
}

export async function updateConnectionTokens(
  connectionId: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }
) {
  await db.update(integrationConnections)
    .set({
      accessTokenEncrypted: encrypt(tokens.accessToken),
      refreshTokenEncrypted: encrypt(tokens.refreshToken),
      tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, connectionId));
}

export async function disconnectIntegration(connectionId: string) {
  await requireAdmin();
  await db.update(integrationConnections)
    .set({
      isActive: false,
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      disconnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, connectionId));
}

export async function toggleAutoSync(connectionId: string, enabled: boolean) {
  await requireAdmin();
  await db.update(integrationConnections)
    .set({
      autoSyncOnApproval: enabled,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, connectionId));
}

// ---------------------------------------------------------------------------
// Entity Mapping
// ---------------------------------------------------------------------------

export async function getMappings(connectionId: string) {
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
  await requireAdmin();

  // Upsert — update if mapping already exists for this connection + entity type + bytime ID
  const existing = await db
    .select({ id: integrationEntityMappings.id })
    .from(integrationEntityMappings)
    .where(
      and(
        eq(integrationEntityMappings.connectionId, data.connectionId),
        eq(integrationEntityMappings.entityType, data.entityType),
        eq(integrationEntityMappings.bytimeEntityId, data.bytimeEntityId),
      )
    );

  if (existing.length > 0) {
    await db.update(integrationEntityMappings)
      .set({
        externalEntityId: data.externalEntityId,
        externalEntityName: data.externalEntityName,
        metadata: data.metadata,
        updatedAt: new Date(),
      })
      .where(eq(integrationEntityMappings.id, existing[0].id));
  } else {
    await db.insert(integrationEntityMappings).values(data);
  }
}

export async function deleteMapping(mappingId: string) {
  await requireAdmin();
  await db.delete(integrationEntityMappings).where(eq(integrationEntityMappings.id, mappingId));
}

// ---------------------------------------------------------------------------
// Sync Logs
// ---------------------------------------------------------------------------

export async function getSyncLogs(connectionId: string, limit = 20) {
  await requireAdmin();
  return db
    .select()
    .from(integrationSyncLogs)
    .where(eq(integrationSyncLogs.connectionId, connectionId))
    .orderBy(desc(integrationSyncLogs.createdAt))
    .limit(limit);
}

export async function getSyncRecords(syncLogId: string) {
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
