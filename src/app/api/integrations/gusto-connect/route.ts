import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getGustoAuthUrl } from '@/lib/integrations/connectors/gusto-api';

/**
 * Redirect to Gusto OAuth authorization page.
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
    const authUrl = getGustoAuthUrl();
    return NextResponse.redirect(authUrl);
  } catch (error) {
    return NextResponse.redirect(
      new URL('/admin/integrations?error=gusto_config_missing', request.url)
    );
  }
}
