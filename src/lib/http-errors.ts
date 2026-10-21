import { NextResponse } from 'next/server';

/**
 * Translates an error thrown by a guard (requireSession/requireAdmin/requireApprover/
 * assertCanAccessEmployee in @/lib/session) into the matching HTTP response, for Route
 * Handlers that call guarded server actions directly instead of going through the
 * Server Actions transport.
 */
export function guardErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof Error) {
    if (error.message.startsWith('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error.message.startsWith('Forbidden')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
  return null;
}
