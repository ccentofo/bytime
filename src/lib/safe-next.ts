import { covers } from '@/components/shell/nav-config';

/**
 * Sanitize a post-sign-in `next` path (feature-plan-ux-timesheet.md A4.8, invariant A3.5 "no open redirect"). Pure.
 * Returns its input UNCHANGED, or null — never a rewritten value (UX-3 fix round 1, M2: rewriting decoded `%23`, `%26`,
 * `%3F` and changed the query). The value must already be in its final, encoded URL form (x-cp-path is; the login page
 * gets the same string back from Next's once-decoded searchParams, because loginRedirect encodes it exactly once).
 *
 * Refused: anything the URL parser would normalise (dot segments — including encoded and double-encoded ones —
 * fragments, unescaped spaces…), so what is checked is exactly what the router will open; a backslash or control
 * character in the input or its decoded copy; anything not a same-origin path on the allowlist.
 */

const MAX_LENGTH = 512;
const ALLOWED = ['/timesheet', '/home', '/admin', '/settings', '/profile'];
const DENIED = ['/login', '/api', '/signup', '/reset-password', '/forgot-password'];
const CONTROL = /[\u0000-\u001f\u007f]/; // includes tab, CR and LF
const BASE = 'http://x';

const unsafeChars = (s: string) => s.includes('\\') || CONTROL.test(s);
const decodeOnce = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
/** True when the WHATWG parser would leave this path (or path + query) exactly as written. */
const parsesUnchanged = (s: string, withQuery: boolean): boolean => {
  try {
    const url = new URL(s, BASE);
    return url.origin === BASE && (withQuery ? url.pathname + url.search : url.pathname) === s;
  } catch {
    return false;
  }
};

export function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (unsafeChars(raw) || !raw.startsWith('/') || raw.startsWith('//')) return null;

  // The decoded copy must be just as clean (no %5C, %0A, %00…).
  const decoded = decodeOnce(raw);
  if (decoded === null || unsafeChars(decoded)) return null;

  // The input itself must parse unchanged: no dot segments (incl. %2e%2e), no fragment, nothing re-escaped.
  if (!parsesUnchanged(raw, true)) return null;

  // Its PATH, decoded once, must also be a plain path that parses unchanged — this refuses double-encoded dot
  // segments (%252e%252e → %2e%2e → ..), an encoded '?', '#' or '//' in the path, and a decoded '.'/'..' segment.
  const path = raw.split('?', 1)[0];
  const decodedPath = decodeOnce(path);
  if (decodedPath === null || unsafeChars(decodedPath) || !decodedPath.startsWith('/') || decodedPath.includes('//')) return null;
  if (decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (!parsesUnchanged(decodedPath, false)) return null;

  if (!ALLOWED.some((prefix) => covers(prefix, path))) return null;
  if (DENIED.some((prefix) => covers(prefix, path))) return null;
  return raw;
}
