/**
 * Stored tenant/control-plane URLs use Neon's POOLED host (`ep-…-pooler.…`) because that's right for
 * the serverless app. But that pooler is PgBouncer in transaction mode, where a session-level
 * advisory lock is NOT held across statements — a migration or backup lock would silently stop
 * protecting anything. So lock holders, migrations and dumps always connect to the DIRECT host (same
 * name without `-pooler`). Non-Neon URLs (local Postgres, CI) have no `-pooler` label and pass
 * through unchanged.
 *
 * Its own module with no imports (feature-plan-database-backups.md §10.1): the backup image bundles it, so
 * app-side migration edits in migrate-tenant.ts don't change the backup bundle.
 */
export function toDirectConnectionUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const [firstLabel, ...rest] = parsed.hostname.split('.');
  if (!firstLabel.endsWith('-pooler')) return url;
  parsed.hostname = [firstLabel.slice(0, -'-pooler'.length), ...rest].join('.');
  return parsed.toString();
}
