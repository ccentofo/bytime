'use server';

import { db } from '@/db';
import { apiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import crypto from 'crypto';

/**
 * Generate a new API key. Returns the full key ONCE (it's not stored).
 * The hash is stored for later validation.
 */
export async function createApiKey(data: {
  name: string;
  createdByUserId: string;
  permissions?: 'read' | 'read-write';
  expiresAt?: Date;
}): Promise<{ id: string; key: string; prefix: string }> {
  await requireAdmin();

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
    createdByUserId: data.createdByUserId,
    permissions: data.permissions ?? 'read',
    expiresAt: data.expiresAt ?? null,
  }).returning();

  return {
    id: rows[0].id,
    key: fullKey, // Only returned once — user must copy it
    prefix,
  };
}

/**
 * Get all API keys (without the actual key — only prefix shown).
 */
export async function getApiKeys() {
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
export async function revokeApiKey(id: string): Promise<void> {
  await requireAdmin();
  await db.update(apiKeys)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(apiKeys.id, id));
}

/**
 * Delete an API key permanently.
 */
export async function deleteApiKey(id: string): Promise<void> {
  await requireAdmin();
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
}
