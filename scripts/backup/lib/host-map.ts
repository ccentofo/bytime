/**
 * Test-only host mapping (impact analysis §4, approved detail D10). Every local database lives on one server, so the
 * disaster suites give each fake Neon endpoint a Neon-shaped host (`ep-….us-east-1.aws.neon.tech`) and map it here to
 * the local server (or to the local Neon-proxy stand-in). The map is applied ONLY when opening a connection (postgres.js,
 * or pg_restore's `--dbname`); every comparison, guard and stored URL keeps the original host.
 *
 * Production never passes a map: it is an in-process dependency only (never read from the environment), and a test
 * asserts that main.ts never sets it.
 */
export type HostMap = Record<string, { host: string; port: number }>;

/** The URL to actually connect to: the mapped host and port when the URL's host is mapped, else the URL unchanged. */
export function connectUrl(url: string, map?: HostMap): string {
  if (!map) return url;
  const u = new URL(url);
  const target = map[u.hostname.toLowerCase()];
  if (!target) return url;
  u.hostname = target.host;
  u.port = String(target.port);
  return u.toString();
}
