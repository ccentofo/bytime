'use server';

import { getDb, getDbForWrite } from '@/db';
import { apiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import crypto from 'crypto';
import { userAction, type ActionResult } from '@/lib/action-result';

/**
 * Generate a new API key. Returns the full key ONCE (it's not stored).
 * The hash is stored for later validation.
 */
export async function createApiKey(data: {
  name: string;
  permissions?: 'read' | 'read-write';
  expiresAt?: Date;
}): Promise<ActionResult<{ id: string; key: string; prefix: string }>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();

    // Generate a random API key: "byt_" + 32 random hex chars
    const randomBytes = crypto.randomBytes(24);
    const keyBody = randomBytes.toString('hex');
    const fullKey = `byt_${keyBody}`;
    const prefix = fullKey.substring(0, 8);

    // Hash the key for storage
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');

    const rows = await db.insert(apiKeys).values({
      name: data.name,
      keyHash,
      keyPrefix: prefix,
      createdByUserId: actor.id,
      permissions: data.permissions ?? 'read',
      expiresAt: data.expiresAt ?? null,
    }).returning();

    return {
      id: rows[0].id,
      key: fullKey, // Only returned once — user must copy it
      prefix,
    };
  });
}

/**
 * Get all API keys (without the actual key — only prefix shown).
 */
export async function getApiKeys() {
  const db = await getDb();
  await requireAdmin();
  return db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    keyPrefix: apiKeys.keyPrefix,
    permissions: apiKeys.permissions,
    isActive: apiKeys.isActive,
    lastUsedAt: apiKeys.lastUsedAt,
    expiresAt: apiKeys.expiresAt,
    createdAt: apiKeys.createdAt,
  }).from(apiKeys).orderBy(apiKeys.createdAt);
}

/**
 * Revoke (deactivate) an API key.
 */
export async function revokeApiKey(id: string): Promise<ActionResult<void>> {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    await db.update(apiKeys)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(apiKeys.id, id));
  });
}

/**
 * Delete an API key permanently.
 */
export async function deleteApiKey(id: string): Promise<ActionResult<void>> {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  });
}
