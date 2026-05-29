import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getConnector } from '@/lib/integrations/registry';
import { createConnection } from '@/server/actions/integrations';

/**
 * Generic OAuth callback handler for all integration providers.
 * URL: /api/integrations/callback/quickbooks_online?code=...&realmId=...
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const role = (session.user as any).role;
  if (role !== 'admin') {
    return NextResponse.redirect(new URL('/timesheet', request.url));
  }

  const connector = getConnector(provider);
  if (!connector || !connector.exchangeCodeForTokens) {
    return NextResponse.redirect(
      new URL(`/admin/integrations?error=unknown_provider`, request.url)
    );
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const realmId = searchParams.get('realmId') ?? undefined;
  const error = searchParams.get('error');

  if (error || !code) {
    return NextResponse.redirect(
      new URL(`/admin/integrations?error=${error ?? 'no_code'}`, request.url)
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
      connectedBy: session.user.id,
    });

    return NextResponse.redirect(
      new URL('/admin/integrations?connected=true', request.url)
    );
  } catch (err) {
    console.error(`OAuth callback error for ${provider}:`, err);
    return NextResponse.redirect(
      new URL(`/admin/integrations?error=connection_failed`, request.url)
    );
  }
}
