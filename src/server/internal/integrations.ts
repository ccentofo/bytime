import 'server-only';
import type { TenantWriter } from '@/db';
import { integrationConnections, integrationProviderEnum } from '@/db/schema';
import { encrypt } from '@/lib/encryption';
import { UserFacingError } from '@/lib/errors';

/**
 * Save a new integration connection with its OAuth tokens (encrypted at rest).
 *
 * INTERNAL — not a server action. Only the OAuth completion route calls this, after it has
 * authorized the admin (requireAdminFresh) and verified the signed state and nonce, and it passes its own
 * write-gated client (internal writers never obtain one — feature-plan-launch-blockers.md P4). Keeping it
 * out of a 'use server' file means no client can submit arbitrary tokens directly.
 */
export async function saveIntegrationConnection(db: TenantWriter, connectedBy: string, data: {
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
  if (!provider) throw new UserFacingError(`Unknown integration provider: ${data.provider}`);
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
