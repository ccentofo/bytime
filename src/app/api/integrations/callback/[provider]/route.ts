import { NextRequest, NextResponse } from 'next/server';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { isValidSlug } from '@/lib/tenant/provision';

/**
 * Apex OAuth callback — the single redirect URI registered with Intuit/Gusto.
 * URL: /api/integrations/callback/quickbooks_online?code=...&realmId=...&state=...
 *
 * R2-9: this runs on the APEX domain, where no tenant subdomain session cookie exists — there
 * is no session to check here. It does exactly one job: verify the signed `state` (signature +
 * expiry), then forward the code/realmId/state to the TENANT subdomain's own "complete" route,
 * which re-verifies everything (including the single-use nonce cookie) and does the actual
 * token exchange. The tenantSlug is taken ONLY from the verified state payload, never from a
 * query param, and is validated with isValidSlug() before being used to build a URL — this
 * callback must never redirect anywhere an attacker could choose.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const realmId = searchParams.get('realmId');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  const payload = verifyOAuthState(state);
  if (!payload || payload.provider !== provider || !isValidSlug(payload.tenantSlug)) {
    return NextResponse.json({ error: 'Invalid or expired authorization request. Please try connecting again.' }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const rootDomain = process.env.APP_ROOT_DOMAIN ?? 'localhost';
  const u = new URL(appUrl);
  const port = u.port ? `:${u.port}` : '';
  const tenantBase = `${u.protocol}//${payload.tenantSlug}.${rootDomain}${port}`;

  // The user declined consent (or the provider failed): send them back to their own workspace
  // with a fixed error code. The provider's error text is never reflected.
  if (error || !code) {
    return NextResponse.redirect(new URL(`${tenantBase}/admin/integrations?error=connection_cancelled`));
  }

  const completeUrl = new URL(`${tenantBase}/api/integrations/complete/${encodeURIComponent(provider)}`);
  completeUrl.searchParams.set('code', code);
  if (realmId) completeUrl.searchParams.set('realmId', realmId);
  completeUrl.searchParams.set('state', state!);

  return NextResponse.redirect(completeUrl);
}
