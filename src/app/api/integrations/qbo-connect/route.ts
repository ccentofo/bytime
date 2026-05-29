import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getQBOAuthUrl } from '@/lib/integrations/connectors/qbo-api';

/**
 * Redirect to QuickBooks Online OAuth authorization page.
 * GET /api/integrations/qbo-connect
 */
export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const role = (session.user as any).role;
  if (role !== 'admin') {
    return NextResponse.redirect(new URL('/timesheet', request.url));
  }

  try {
    const authUrl = getQBOAuthUrl();
    return NextResponse.redirect(authUrl);
  } catch (error) {
    return NextResponse.redirect(
      new URL('/admin/integrations?error=qbo_config_missing', request.url)
    );
  }
}
