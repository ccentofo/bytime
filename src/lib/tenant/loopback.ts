/**
 * Pure loopback check for database URLs (feature-plan-launch-blockers.md P5/P6): shared by createLocalDevDatabase,
 * the founder-script target banner and the waitlist environment guard. No server-only imports.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when the URL's host is a loopback address (localhost, 127.x, ::1, *.localhost). Unparseable → false. */
export function isLoopbackUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** Same rule for a bare host name (e.g. APP_ROOT_DOMAIN), optionally with a port. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false;
  return isLoopbackUrl(`http://${host}`);
}
