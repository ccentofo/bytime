/**
 * feature-plan-cloud-export.md §6.6 (invariant 5): the export download link's token must never reach Sentry. One shared
 * deep scrub, wired into `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` in all three Sentry inits (server,
 * edge, browser). No imports: safe in every runtime. No regex lookbehind (older browsers can't parse it).
 *
 * 1. Headers that carry the page's URL or router state lose their values wherever headers appear (`request.headers`,
 *    span/transaction attributes `http.request.header.*`), matched case-insensitively and with `_` or `-`:
 *    `next-router-state-tree` (the URL-encoded router tree holds the bare token: `["token","<TOKEN>","d",null]`),
 *    `next-url` and `referer` (audit round 1, FR1).
 * 2. Every string and key, as defence in depth: `/export/<token>` and its URL-encoded form `%2Fexport%2F<token>` become
 *    `/export/[token]`; a URL-encoded quoted token `%22<token>%22` (the router tree's form) becomes `%22[token]%22`; and any
 *    standalone 43-character base64url run (the token's exact shape) becomes `[token]`.
 * 3. Query and fragment parameters that carry a secret or a person (SWEEP-FINDINGS.md A1-D1): the value of `token`, any
 *    name ending in `token` (`access_token`, `id_token`, …), `email`, `code` and `state`, after `?`, `&` or `#`, or their
 *    URL-encoded forms `%3F`, `%26`, `%23` (with `=` or `%3D`), case-insensitive, becomes `[Filtered]`. These carry the
 *    set-password, password-reset and signup-verify links (`/reset-password?token=…&email=…`) and OAuth callbacks.
 *    Sentry's `request.query_string` holds the query without its `?`, so a string under that key is scrubbed as if it had one.
 */

const TOKEN_IN_PATH = /\/export\/[A-Za-z0-9_-]{43}/g;
const TOKEN_IN_ENCODED_PATH = /%2Fexport%2F[A-Za-z0-9_-]{43}/gi;
/** The URL-encoded router tree quotes the token (`%22<TOKEN>%22`), which glues `22` onto both ends of the run. */
const TOKEN_IN_ENCODED_QUOTES = /%22[A-Za-z0-9_-]{43}%22/gi;
const STANDALONE_TOKEN = /(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?=$|[^A-Za-z0-9_-])/g;
/** A plain `?name=value` / `&name=value` / `#name=value`: the value runs to the next `&`, `#`, whitespace or quote. */
const SENSITIVE_PARAM = /([?&#])([\w.-]*token|email|code|state)=[^&#\s"]*/gi;
/** The URL-encoded form (`%3Ftoken%3D…%26email%3D…`): the value also stops at an encoded `&` or `#`. */
const SENSITIVE_ENCODED_PARAM = /(%3F|%26|%23)([\w.-]*token|email|code|state)(=|%3D)(?:(?!%26|%23)[^&#\s"])*/gi;
const SENSITIVE_HEADERS = ['next-router-state-tree', 'next-url', 'referer'];
const MAX_DEPTH = 32;
export const FILTERED = '[Filtered]';

export function scrubString(s: string): string {
  return s
    .replace(SENSITIVE_PARAM, `$1$2=${FILTERED}`)
    .replace(SENSITIVE_ENCODED_PARAM, `$1$2$3${FILTERED}`)
    .replace(TOKEN_IN_PATH, '/export/[token]')
    .replace(TOKEN_IN_ENCODED_PATH, '/export/[token]')
    .replace(TOKEN_IN_ENCODED_QUOTES, '%22[token]%22')
    .replace(STANDALONE_TOKEN, '$1[token]');
}

/** A header name, or an attribute such as `http.request.header.next_router_state_tree`, that must lose its value. */
export function isSensitiveHeaderKey(key: string): boolean {
  const k = key.toLowerCase().replace(/_/g, '-');
  return SENSITIVE_HEADERS.some((h) => k === h || k.endsWith(`.${h}`));
}

function scrub(v: unknown, depth: number, seen: WeakMap<object, unknown>): unknown {
  if (typeof v === 'string') return scrubString(v);
  if (v === null || typeof v !== 'object' || depth > MAX_DEPTH) return v;
  if (seen.has(v)) return seen.get(v);
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    seen.set(v, out);
    for (const x of v) out.push(scrub(x, depth + 1, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // Dates, Errors, typed arrays: left as they are
  const out: Record<string, unknown> = {};
  seen.set(v, out);
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[scrubString(k)] = isSensitiveHeaderKey(k) && x !== undefined && x !== null ? FILTERED
      : k === 'query_string' && typeof x === 'string' ? scrubString(`?${x}`).slice(1)
      : scrub(x, depth + 1, seen);
  }
  return out;
}

/** A deep copy with sensitive headers filtered and every token replaced (plain objects and arrays; others kept as they are). */
export function deepScrub<T>(value: T): T {
  return scrub(value, 0, new WeakMap()) as T;
}

/** The three hooks, typed loosely so each Sentry init can pass them as they are. */
export const scrubEvent = <T>(event: T): T => deepScrub(event);
export const scrubBreadcrumb = <T>(breadcrumb: T): T => deepScrub(breadcrumb);
