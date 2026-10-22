import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { checkCronRateLimit } from '@/lib/rate-limit';

/**
 * Shared cron guard: rate limit, then CRON_SECRET (fail-closed in production). Accepts `x-cron-secret`
 * (GitHub Actions) or `Authorization: Bearer` (Vercel native crons). Returns a response to send, or null.
 */
export function rejectUnauthorizedCron(request: NextRequest): Response | null {
  const rateLimited = checkCronRateLimit(request);
  if (rateLimited) return rateLimited;
  const provided = request.headers.get('x-cron-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.CRON_SECRET && provided !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
