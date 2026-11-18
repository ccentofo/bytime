/**
 * The URL every postgres.js client in the app and its scripts connects with (url-fix, 2026-11-18).
 *
 * postgres.js passes any URL query parameter it doesn't know to the server as a startup setting
 * (node_modules/postgres/src/index.js:488, postgres 3.4.9). Neon's connection strings end with
 * `?sslmode=require&channel_binding=require`, and Postgres rejects `channel_binding` as a setting
 * (`42704 unrecognized configuration parameter "channel_binding"`); libpq's `keepalives*` fail the same way.
 * So the query is reduced to an allow-list at connect time. It's the same rule as the backup image's `clientUrl`
 * (scripts/backup/lib/pg-url.ts), which stays separate because that image bundles its own copy.
 *
 * - A URL whose query has only allow-listed keys (or no query) comes back byte-for-byte unchanged.
 * - An empty or unparseable URL also comes back unchanged, so postgres.js and the callers' own guards
 *   (for example `clientFor`'s empty-URL refusal) behave exactly as before.
 * - Otherwise the other keys are deleted and the URL is re-serialised. The user, password, host, port and database
 *   keep their encoding, so postgres.js decodes the same credentials.
 *
 * No imports: the drizzle-kit configs load this file by relative path.
 */
const POSTGRES_JS_QUERY_ALLOWLIST = new Set(['sslmode']);

export function postgresJsUrl(url: string): string {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const extra = [...new Set(parsed.searchParams.keys())].filter((k) => !POSTGRES_JS_QUERY_ALLOWLIST.has(k));
  if (extra.length === 0) return url;
  for (const k of extra) parsed.searchParams.delete(k);
  return parsed.toString();
}
