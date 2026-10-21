import { NextRequest, NextResponse } from 'next/server';
import { requireAdminFresh, AuthorizationError } from '@/lib/session';
import { getTenantSlug } from '@/lib/tenant/context';
import { getQBOAuthUrl } from '@/lib/integrations/connectors/qbo-api';
import { generateOAuthNonce, mintOAuthState } from '@/lib/integrations/oauth-state';

const NONCE_COOKIE = 'qbo_oauth_nonce';

/**
 * Redirect to QuickBooks Online OAuth authorization page.
 * GET /api/integrations/qbo-connect
 *
 * R2-9: mints a signed `state` binding this tenant + admin + a single-use nonce, and stores the
 * nonce in an httpOnly cookie on this tenant host. The apex callback can't check a session (no
 * tenant cookie exists there), so this is what proves the eventual callback belongs to the admin
 * who clicked Connect, on the SAME tenant, within a short window.
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
    return NextResponse.redirect(new URL('/admin/integrations?error=qbo_config_missing', request.url));
  }

  try {
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug, userId: actor.id, provider: 'quickbooks_online', nonce });
    const authUrl = getQBOAuthUrl(state);

    const response = NextResponse.redirect(authUrl);
    response.cookies.set(NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
      // No `domain` — host-only, scoped to this exact tenant subdomain.
    });
    return response;
  } catch {
    return NextResponse.redirect(
      new URL('/admin/integrations?error=qbo_config_missing', request.url)
    );
  }
}
