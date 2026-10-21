import { NextRequest, NextResponse } from 'next/server';
import { requireAdminFresh, AuthorizationError } from '@/lib/session';
import { getTenantSlug } from '@/lib/tenant/context';
import { getConnector } from '@/lib/integrations/registry';
import { createConnection } from '@/server/actions/integrations';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';

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

  let actor;
  try {
    actor = await requireAdminFresh();
  } catch (error) {
    if (error instanceof AuthorizationError && error.kind === 'unauthenticated') {
      return NextResponse.redirect(new URL('/login', request.url));
    }
    return NextResponse.redirect(new URL('/timesheet', request.url));
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const realmId = searchParams.get('realmId') ?? undefined;
  const state = searchParams.get('state');

  const payload = verifyOAuthState(state);
  const nonceCookieName = NONCE_COOKIES[provider];
  const cookieNonce = nonceCookieName ? request.cookies.get(nonceCookieName)?.value : undefined;
  const tenantSlug = await getTenantSlug();

  const valid =
    !!code &&
    !!payload &&
    payload.provider === provider &&
    payload.userId === actor.id &&
    payload.tenantSlug === tenantSlug &&
    !!cookieNonce &&
    payload.nonce === cookieNonce;

  if (!valid) {
    const response = NextResponse.redirect(new URL('/admin/integrations?error=connection_failed', request.url));
    if (nonceCookieName) response.cookies.delete(nonceCookieName);
    return response;
  }

  // Single-use: the nonce cookie is consumed here regardless of what happens next.
  const clearNonceCookie = (response: NextResponse) => {
    if (nonceCookieName) response.cookies.delete(nonceCookieName);
    return response;
  };

  const connector = getConnector(provider);
  if (!connector || !connector.exchangeCodeForTokens) {
    return clearNonceCookie(
      NextResponse.redirect(new URL('/admin/integrations?error=unknown_provider', request.url))
    );
  }

  try {
    const tokens = await connector.exchangeCodeForTokens(code, realmId);

    await createConnection({
      provider,
      displayName: `${connector.metadata.name}${tokens.companyName ? ` — ${tokens.companyName}` : ''}`,
      externalCompanyId: tokens.realmId,
      externalCompanyName: tokens.companyName,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
    });

    return clearNonceCookie(
      NextResponse.redirect(new URL('/admin/integrations?connected=true', request.url))
    );
  } catch (err) {
    console.error(`OAuth completion error for ${provider}:`, err);
    return clearNonceCookie(
      NextResponse.redirect(new URL('/admin/integrations?error=connection_failed', request.url))
    );
  }
}
