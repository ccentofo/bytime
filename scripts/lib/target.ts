/**
 * Founder-script target banner (feature-plan-launch-blockers.md P6 §5): every founder script prints which control
 * plane it is about to touch — host and database only, never credentials — and a boxed warning when that is not a
 * loopback (local) database. Pure: no env loading, no server-only imports, so scripts and tests can both use it.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when the URL's host is a loopback address (localhost, 127.0.0.1, ::1, *.localhost). Unparseable → false. */
export function isLoopbackUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** `host[:port]/database` of a postgres URL, without user, password or query. Unparseable → a placeholder. */
export function describeDatabaseUrl(url: string | undefined | null): string {
  if (!url) return '(not set)';
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, '') || '(default database)';
    return `${u.host}/${db}`;
  } catch {
    return '(unparseable URL)';
  }
}

/** The banner text (exported for tests). */
export function targetBanner(url: string | undefined | null, label = 'Target control plane'): string {
  const line = `${label}: ${describeDatabaseUrl(url)}`;
  if (isLoopbackUrl(url)) return line;
  const warning = '⚠  NOT A LOCAL DATABASE — this script will act on a remote control plane.';
  const width = Math.max(line.length, warning.length) + 2;
  const row = (s: string) => `║ ${s.padEnd(width - 1)}║`;
  return [`╔${'═'.repeat(width)}╗`, row(warning), row(line), `╚${'═'.repeat(width)}╝`].join('\n');
}

/** Print the banner for the control plane this process will use. Call before any database work. */
export function printTargetBanner(url: string | undefined | null = process.env.CONTROL_PLANE_DATABASE_URL, label?: string): void {
  console.log(targetBanner(url, label));
}
