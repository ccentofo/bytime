/**
 * A local copy of src/lib/tenant/loopback.ts's isLoopbackUrl (feature-plan-database-backups.md §6.4): the backup bundle's
 * only src/ inputs are encryption.ts, direct-url.ts and backup-locks.ts, so this rule is duplicated rather than imported.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}
