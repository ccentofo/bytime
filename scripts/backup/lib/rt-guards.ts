/**
 * Restore-test target guards (feature-plan-database-backups.md §6.7 step 1, invariant 9, F15, U11). The restore-test URL
 * is refused when:
 *  - its direct host equals the control plane's direct host;
 *  - it is a pooled host (`-pooler`): pg_restore needs a direct connection;
 *  - it isn't a Neon us-east-1 host (cell labels allowed): Neon's defaults are us-east-2 and Postgres 18;
 *  - its server isn't Postgres 16;
 *  - its database holds user tables (a production URL pasted by mistake).
 * The host-guard override (tests only, an in-process parameter, never an environment variable) skips the first and
 * third checks, because CI's servers share localhost and aren't Neon. The others always run.
 */
import { toDirectConnectionUrl } from '../../../src/lib/tenant/direct-url';
import { parseNeonHost } from './neon-host';
import { hostOf } from './pg-url';
import { BASE_TABLES_SQL } from './counts';

export interface GuardSql {
  unsafe: (query: string) => Promise<Array<Record<string, unknown>>>;
}

/** URL-only checks. Returns the refusal reason, or null. */
export function restoreUrlRefusal(controlPlaneUrl: string, restoreUrl: string, opts: { hostGuardOverride?: boolean } = {}): string | null {
  let rtHost: string;
  let cpHost: string;
  try {
    rtHost = hostOf(restoreUrl);
    cpHost = hostOf(toDirectConnectionUrl(controlPlaneUrl));
  } catch {
    return 'unparseable URL';
  }
  if (rtHost.split('.')[0].endsWith('-pooler')) return 'pooled host';
  if (opts.hostGuardOverride) return null;
  if (hostOf(toDirectConnectionUrl(restoreUrl)) === cpHost) return 'same host as the control plane';
  const neon = parseNeonHost(rtHost);
  if (!neon || neon.pooled || neon.region !== 'us-east-1') return 'not a Neon us-east-1 host';
  return null;
}

/** Server checks on a connection to the restore-test database. Returns the refusal reason, or null. */
export async function restoreServerRefusal(sql: GuardSql): Promise<string | null> {
  const [v] = await sql.unsafe(`SELECT current_setting('server_version_num')::int AS n`);
  const n = Number(v?.n);
  if (!(n >= 160000 && n <= 169999)) return 'server version is not 16';
  const tables = await sql.unsafe(BASE_TABLES_SQL);
  if (tables.length > 0) return 'database holds user tables';
  return null;
}
