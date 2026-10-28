import { covers } from '@/components/shell/nav-config';

/**
 * Sanitize a post-sign-in `next` path (feature-plan-ux-timesheet.md A4.8, invariant A3.5 "no open redirect"). Pure.
 * Returns a same-origin app path on the allowlist, or null. The structural checks run on the path REBUILT by the URL
 * parser — never only on the input — because `new URL('/timesheet/..//evil.com', base)` normalises to `//evil.com`.
 */

const MAX_LENGTH = 512;
const ALLOWED = ['/timesheet', '/home', '/admin', '/settings', '/profile'];
const DENIED = ['/login', '/api', '/signup', '/reset-password', '/forgot-password'];
const CONTROL = /[\u0000-\u001f\u007f]/; // includes tab, CR and LF
const BASE = 'http://x';

const unsafeChars = (s: string) => s.includes('\\') || CONTROL.test(s);

export function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (unsafeChars(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw); // once
  } catch {
    return null;
  }
  if (unsafeChars(decoded)) return null;
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;
  // No decoded '.' or '..' path segment (the parser would resolve it — possibly into '//host').
  const path = decoded.split(/[?#]/, 1)[0];
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;

  let url: URL;
  try {
    url = new URL(decoded, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const rebuilt = url.pathname + url.search;
  if (!rebuilt.startsWith('/') || rebuilt.startsWith('//') || unsafeChars(rebuilt)) return null;
  if (!ALLOWED.some((prefix) => covers(prefix, url.pathname))) return null;
  if (DENIED.some((prefix) => covers(prefix, url.pathname))) return null;
  return rebuilt;
}
