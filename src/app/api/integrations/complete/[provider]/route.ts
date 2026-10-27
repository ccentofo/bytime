import { NextRequest, NextResponse } from 'next/server';
import { requireAdminFresh, AuthorizationError } from '@/lib/session';
import { getTenantSlug } from '@/lib/tenant/context';
import { getConnector } from '@/lib/integrations/registry';
import { saveIntegrationConnection } from '@/server/internal/integrations';
import { getDbForWrite } from '@/db';
import { verifyOAuthState, safeEqual } from '@/lib/integrations/oauth-state';

const NONCE_COOKIES: Record<string, string> = {
  quickbooks_online: 'qbo_oauth_nonce',
  gusto: 'gusto_oauth_nonce',
};

/**
 * Tenant-side OAuth completion route — where the apex callback (callback/[provider]/route.ts)
 * forwards to after verifying the signed `state`. Runs on the TENANT subdomain, so a real
 * session exists here. Re-verifies the state's signature/expiry AND binds it to THIS admin, THIS
 * tenant, and the single-use nonce cookie set when the flow started — only then exchanges the
 * code and saves the connection (R2-9).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const nonceCookieName = NONCE_COOKIES[provider];
  const cookieNonce = nonceCookieName ? request.cookies.get(nonceCookieName)?.value : undefined;

  // Single-use: the nonce cookie is cleared on EVERY exit from this route, success or failure.
  const response = await complete(request, provider, cookieNonce);
  if (nonceCookieName) response.cookies.delete(nonceCookieName);
  return response;
}

async function complete(request: NextRequest, provider: string, cookieNonce: string | undefined): Promise<NextResponse> {
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, request.url));

  let actor;
  try {
    actor = await requireAdminFresh();
  } catch (error) {
    if (error instanceof AuthorizationError && error.kind === 'unauthenticated') return redirectTo('/login');
    return redirectTo('/timesheet');
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const realmId = searchParams.get('realmId') ?? undefined;
  const payload = verifyOAuthState(searchParams.get('state'));

  let tenantSlug: string;
  try {
    tenantSlug = await getTenantSlug();
  } catch {
    return redirectTo('/settings/integrations?error=connection_failed');
  }

  const valid =
    !!code &&
    !!payload &&
    payload.provider === provider &&
    payload.userId === actor.id &&
    payload.tenantSlug === tenantSlug &&
    !!cookieNonce &&
    safeEqual(payload.nonce, cookieNonce);

  if (!valid) return redirectTo('/settings/integrations?error=connection_failed');

  const connector = getConnector(provider);
  if (!connector || !connector.exchangeCodeForTokens) {
    return redirectTo('/settings/integrations?error=unknown_provider');
  }

  try {
    const tokens = await connector.exchangeCodeForTokens(code, realmId);

    await saveIntegrationConnection(await getDbForWrite(), actor.id, {
      provider,
      displayName: `${connector.metadata.name}${tokens.companyName ? ` — ${tokens.companyName}` : ''}`,
      externalCompanyId: tokens.realmId,
      externalCompanyName: tokens.companyName,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
    });

    return redirectTo('/settings/integrations?connected=true');
  } catch (err) {
    console.error(`OAuth completion error for ${provider}:`, err);
    return redirectTo('/settings/integrations?error=connection_failed');
  }
}
