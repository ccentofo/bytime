import { NextResponse } from 'next/server';
import { AuthorizationError } from '@/lib/session';

/**
 * Translates an error thrown by a guard (requireSession/requireAdmin/requireApprover/
 * assertCanAccessEmployee in @/lib/session) into the matching HTTP response, for Route
 * Handlers that call guarded server actions directly instead of going through the
 * Server Actions transport.
 *
 * R2-12: branches on `instanceof AuthorizationError` + `.kind`, not a message-string prefix —
 * a route wouldn't notice its own wording drifting out of sync with what this function matches.
 * A non-authorization error (a real bug, a business-logic rejection) returns 500, not 401 —
 * mapping every error to "Unauthorized" hid real failures behind a misleading status code.
 */
export function guardErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthorizationError) {
    return NextResponse.json(
      { error: error.kind === 'unauthenticated' ? 'Unauthorized' : 'Forbidden' },
      { status: error.kind === 'unauthenticated' ? 401 : 403 }
    );
  }
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
