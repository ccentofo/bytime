/**
 * Connection URLs (feature-plan-database-backups.md §6.4 "postgres.js URLs", v4.1 §6.2 step 1).
 *
 * - postgres.js passes unknown URL query parameters to the server as startup settings (node_modules/postgres/src/
 *   index.js:494), so Neon's `channel_binding=require` or libpq's `keepalives*` would fail the connection. Every URL given
 *   to postgres.js is reduced to the `sslmode` parameter only.
 * - The libpq child URLs (pg_dump / pg_restore) keep their query, gain TCP keepalives and a connect timeout, and carry no
 *   password: it goes to the child through PGPASSWORD in a minimal environment.
 */

const CLIENT_QUERY_ALLOWLIST = new Set(['sslmode']);

/** The URL for a postgres.js client: query reduced to the allow-list. */
export function clientUrl(url: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (!CLIENT_QUERY_ALLOWLIST.has(k)) u.searchParams.delete(k);
  return u.toString();
}

/** The same server and credentials, another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

export const CHILD_KEEPALIVES: Record<string, string> = {
  connect_timeout: '30',
  keepalives: '1',
  keepalives_idle: '30',
  keepalives_interval: '10',
  keepalives_count: '3',
};

/** Split a URL for a libpq child: the URL without its password (plus keepalives), and the decoded password. */
export function childConnection(url: string): { url: string; password: string } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  for (const [k, v] of Object.entries(CHILD_KEEPALIVES)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return { url: u.toString(), password };
}

/** The only environment a child process gets: PATH, HOME, LANG and PGPASSWORD (§6.4). */
export function childEnv(password: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = { PGPASSWORD: password };
  for (const k of ['PATH', 'HOME', 'LANG'] as const) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}
