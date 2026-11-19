/**
 * feature-plan-cloud-export.md §6.6 (invariant 5): the export download page's path carries its link's token. One shared
 * deep scrub, wired into `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` in all three Sentry inits (server,
 * edge, browser), replaces `/export/<43-character token>` with `/export/[token]` in every string field: URLs, transaction
 * names, span descriptions and data, breadcrumbs, `request.url`. No imports: safe in every runtime.
 */

const TOKEN_IN_PATH = /\/export\/[A-Za-z0-9_-]{43}/g;
const MAX_DEPTH = 32;

export function scrubString(s: string): string {
  return s.includes('/export/') ? s.replace(TOKEN_IN_PATH, '/export/[token]') : s;
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
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[scrubString(k)] = scrub(x, depth + 1, seen);
  return out;
}

/** A deep copy with every token in a string replaced (plain objects and arrays; other objects kept as they are). */
export function deepScrub<T>(value: T): T {
  return scrub(value, 0, new WeakMap()) as T;
}

/** The three hooks, typed loosely so each Sentry init can pass them as they are. */
export const scrubEvent = <T>(event: T): T => deepScrub(event);
export const scrubBreadcrumb = <T>(breadcrumb: T): T => deepScrub(breadcrumb);
