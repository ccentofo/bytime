import { NextRequest, NextResponse } from 'next/server';
import { requireAdminFresh, AuthorizationError } from '@/lib/session';
import { getTenantSlug } from '@/lib/tenant/context';
import { getGustoAuthUrl } from '@/lib/integrations/connectors/gusto-api';
import { generateOAuthNonce, mintOAuthState } from '@/lib/integrations/oauth-state';

const NONCE_COOKIE = 'gusto_oauth_nonce';

/**
 * Redirect to Gusto OAuth authorization page.
 * R2-9: see qbo-connect/route.ts for the full design — same signed-state + nonce-cookie flow.
 */
export async function GET(request: NextRequest) {
  let actor;
  try {
    actor = await requireAdminFresh();
  } catch (error) {
    if (error instanceof AuthorizationError && error.kind === 'unauthenticated') {
      return NextResponse.redirect(new URL('/login', request.url));
    }
    return NextResponse.redirect(new URL('/timesheet', request.url));
  }

  const tenantSlug = await getTenantSlug();
  if (!tenantSlug) {
    return NextResponse.redirect(new URL('/settings/integrations?error=gusto_config_missing', request.url));
  }

  try {
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug, userId: actor.id, provider: 'gusto', nonce });
    const authUrl = getGustoAuthUrl(state);

    const response = NextResponse.redirect(authUrl);
    response.cookies.set(NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600,
      path: '/',
    });
    return response;
  } catch {
    return NextResponse.redirect(
      new URL('/settings/integrations?error=gusto_config_missing', request.url)
    );
  }
}
