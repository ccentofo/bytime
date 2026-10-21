import 'server-only';
import { getDb } from '@/db';
import { integrationConnections } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { encrypt } from '@/lib/encryption';

/**
 * Overwrite a connection's stored OAuth tokens.
 *
 * INTERNAL — not a server action. This has no session to authorize against: it's meant to be
 * called from the OAuth callback route (already admin-gated before exchanging the code) and from
 * token-refresh logic inside the integration connectors, never directly from the client.
 */
export async function updateConnectionTokens(
  connectionId: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }
): Promise<void> {
  const db = await getDb();
  await db.update(integrationConnections)
    .set({
      accessTokenEncrypted: encrypt(tokens.accessToken),
      refreshTokenEncrypted: encrypt(tokens.refreshToken),
      tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, connectionId));
}
