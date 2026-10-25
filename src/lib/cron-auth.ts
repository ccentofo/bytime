import 'server-only';
import { timingSafeEqual } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { checkCronRateLimit } from '@/lib/rate-limit';

/** Constant-time comparison; strings of different lengths are unequal (timingSafeEqual needs equal lengths). */
function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Shared cron guard: CRON_SECRET (fail-closed in production). Accepts `x-cron-secret` (GitHub Actions) or
 * `Authorization: Bearer` (Vercel native crons). Returns a response to send, or null.
 *
 * Launch-blockers audit R12: the secret is checked FIRST and only FAILED attempts count toward (and are refused by) the
 * cron rate limit (2/min/IP → 429). A correct secret is never rate-limited — several crons firing at the same minute
 * from one instance (20:00 UTC) must all run.
 */
export function rejectUnauthorizedCron(request: NextRequest): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected && process.env.NODE_ENV !== 'production') return null; // local dev without a secret
  const provided = request.headers.get('x-cron-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (expected && secretMatches(provided, expected)) return null;
  return checkCronRateLimit(request) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Smoke probe (feature-plan-launch-blockers.md P6 §6): `?probe=1` on a cron route, checked AFTER auth, answers
 * 200 {"probe":"ok"} without doing any work — so a deploy smoke test proves routing + CRON_SECRET without sending mail.
 */
export function isProbe(request: NextRequest): boolean {
  return request.nextUrl.searchParams.get('probe') === '1';
}
