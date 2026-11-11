import 'server-only';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { ReadDb, TenantWriter } from '@/db';
import { integrationConnections, integrationProviderEnum } from '@/db/schema';
import { encrypt } from '@/lib/encryption';
import { UserFacingError } from '@/lib/errors';

type Provider = (typeof integrationProviderEnum.enumValues)[number];

/**
 * Save an integration connection with its OAuth tokens (encrypted at rest).
 *
 * INTERNAL — not a server action. Only the OAuth completion route calls this, after it has
 * authorized the admin (requireAdminFresh) and verified the signed state and nonce, and it passes its own
 * write-gated client (internal writers never obtain one — feature-plan-launch-blockers.md P4). Keeping it
 * out of a 'use server' file means no client can submit arbitrary tokens directly.
 *
 * feature-plan-ux-integrations-billing.md I9: reconnecting keeps the matches. In one transaction under
 * pg_advisory_xact_lock(hashtext('integration-connection:'||provider)):
 * - a row with the same provider and the same NON-NULL company id is reused — the OLDEST one, since every reconnect used
 *   to insert a new row and the oldest is the one the page mapped against — with its tokens, name and connected_at
 *   refreshed and is_active back on;
 * - otherwise (no company id, or a new one) a row is inserted;
 * - in both cases every other active row for the provider is deactivated (tokens cleared, like a disconnect), so there
 *   is one active connection per provider.
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
  const companyId = data.externalCompanyId?.trim() || null;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'integration-connection:' + provider}))`);
    const now = new Date();
    const fields = {
      displayName: data.displayName,
      externalCompanyName: data.externalCompanyName ?? null,
      scopes: data.scopes ?? null,
      connectedBy,
      tokenExpiresAt: data.tokenExpiresAt ?? null,
      accessTokenEncrypted: data.accessToken ? encrypt(data.accessToken) : null,
      refreshTokenEncrypted: data.refreshToken ? encrypt(data.refreshToken) : null,
    };

    const [existing] = companyId
      ? await tx
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(and(eq(integrationConnections.provider, provider), eq(integrationConnections.externalCompanyId, companyId)))
        .orderBy(asc(integrationConnections.createdAt), asc(integrationConnections.id))
        .limit(1)
      : [];

    const [row] = existing
      ? await tx.update(integrationConnections)
        .set({ ...fields, isActive: true, disconnectedAt: null, connectedAt: now, updatedAt: now })
        .where(eq(integrationConnections.id, existing.id))
        .returning({ id: integrationConnections.id })
      : await tx.insert(integrationConnections)
        .values({ ...fields, provider, externalCompanyId: companyId })
        .returning({ id: integrationConnections.id });

    await tx.update(integrationConnections)
      .set({ isActive: false, accessTokenEncrypted: null, refreshTokenEncrypted: null, disconnectedAt: now, updatedAt: now })
      .where(and(
        eq(integrationConnections.provider, provider),
        eq(integrationConnections.isActive, true),
        ne(integrationConnections.id, row.id),
      ));
    return row;
  });
}

/**
 * The provider's active connection (I9: one per provider; if legacy data still has several, the newest, chosen
 * deterministically). Never selects tokens. INTERNAL — callers authorize first.
 */
export async function activeConnection(db: Pick<ReadDb, 'select'>, provider: Provider) {
  const [row] = await db
    .select({
      id: integrationConnections.id,
      provider: integrationConnections.provider,
      displayName: integrationConnections.displayName,
      externalCompanyId: integrationConnections.externalCompanyId,
      externalCompanyName: integrationConnections.externalCompanyName,
      connectedAt: integrationConnections.connectedAt,
      hasTokens: sql<boolean>`(${integrationConnections.accessTokenEncrypted} IS NOT NULL AND ${integrationConnections.refreshTokenEncrypted} IS NOT NULL)`,
    })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.provider, provider), eq(integrationConnections.isActive, true)))
    .orderBy(desc(integrationConnections.connectedAt), desc(integrationConnections.createdAt), desc(integrationConnections.id))
    .limit(1);
  return row ?? null;
}

export type ActiveConnection = NonNullable<Awaited<ReturnType<typeof activeConnection>>>;
