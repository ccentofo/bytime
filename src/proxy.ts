import { NextResponse, type NextRequest } from 'next/server';
import { tenantFromHost } from '@/lib/tenant/host';

export async function proxy(req: NextRequest) {
  const slug = tenantFromHost(req.headers.get('host'));

  // Inject the resolved tenant slug (or empty) as a request header. This OVERWRITES any
  // client-supplied x-tenant-slug. Note: tenant identity is ultimately re-derived from the
  // Host header in src/lib/tenant/context.ts, so isolation does not depend on this header
  // alone — this injection is a convenience/defense-in-depth, not the sole control.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-tenant-slug', slug ?? '');

  // Route protection is enforced server-side (requireSession/requireAdmin in pages/actions).
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    // Run on app routes so the tenant header is present; exclude static assets.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
