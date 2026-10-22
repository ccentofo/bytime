import 'server-only';
import { getDbForWrite } from '@/db';
import { integrationConnections, integrationProviderEnum } from '@/db/schema';
import { encrypt } from '@/lib/encryption';

/**
 * Save a new integration connection with its OAuth tokens (encrypted at rest).
 *
 * INTERNAL — not a server action. Only the OAuth completion route calls this, after it has
 * authorized the admin (requireAdminFresh) and verified the signed state and nonce. Keeping it
 * out of a 'use server' file means no client can submit arbitrary tokens directly.
 */
export async function saveIntegrationConnection(connectedBy: string, data: {
  provider: string;
  displayName: string;
  externalCompanyId?: string;
  externalCompanyName?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  scopes?: string;
}): Promise<{ id: string }> {
  const provider = integrationProviderEnum.enumValues.find((p) => p === data.provider);
  if (!provider) throw new Error(`Unknown integration provider: ${data.provider}`);
  const db = await getDbForWrite();
  const [row] = await db.insert(integrationConnections).values({
    provider,
    displayName: data.displayName,
    externalCompanyId: data.externalCompanyId,
    externalCompanyName: data.externalCompanyName,
    scopes: data.scopes,
    connectedBy,
    tokenExpiresAt: data.tokenExpiresAt,
    accessTokenEncrypted: data.accessToken ? encrypt(data.accessToken) : undefined,
    refreshTokenEncrypted: data.refreshToken ? encrypt(data.refreshToken) : undefined,
  }).returning({ id: integrationConnections.id });
  return row;
}
