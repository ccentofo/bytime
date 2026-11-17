/**
 * Neon host parsing (feature-plan-database-backups.md §4.8.3), shared by the restore-test region guard and the
 * `database_backups.region` column. Hosts look like `ep-<name>[-pooler][.c-<n>].<region>.aws.neon.tech`; some AWS
 * regions add a cell label such as `c-2`. Plain capture groups (the repo targets ES2017; named groups need ES2018):
 * group 1 = `-pooler`, group 2 = the region.
 */
const NEON_HOST_RE = /^ep-[a-z0-9-]+?(-pooler)?(?:\.c-\d+)?\.([a-z0-9-]+)\.aws\.neon\.tech$/;

export interface NeonHost {
  pooled: boolean;
  region: string;
}

export function parseNeonHost(host: string): NeonHost | null {
  const m = NEON_HOST_RE.exec(host.toLowerCase());
  return m ? { pooled: Boolean(m[1]), region: m[2] } : null;
}

/** The region of a URL's host, or `unknown` when it isn't a Neon host (or the URL doesn't parse). */
export function regionOfUrl(url: string): string {
  try {
    return parseNeonHost(new URL(url).hostname)?.region ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
