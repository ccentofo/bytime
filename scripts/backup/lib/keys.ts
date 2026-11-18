/**
 * Object keys, run ids and restore-test database names (feature-plan-database-backups.md §6.4 "Keys", §6.7).
 *
 *   v1/<cp>/<target>/<id>/<YYYY>/<MM>/<DD>/<runId>-<rand8>.dump.enc      (sidecar: …-<rand8>.manifest.json.enc)
 *
 * `<cp>` = the per-environment backup id `prod` or `staging` (feature-plan-control-plane-disaster.md §6.0: SSM
 * `/cadenzpoint/backup/control-plane-backup-id`, injected as BACKUP_CONTROL_PLANE_ID), so a rebuilt control plane (a new
 * host) keeps finding every backup and staging's objects never share production's prefix. Unset (tests, the local dry
 * run): the first 12 hex characters of SHA-256 of the control plane's DIRECT host, as 3b shipped. `<id>` = the tenant
 * uuid, or `control-plane`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { toDirectConnectionUrl } from '../../../src/lib/tenant/direct-url';

export type BackupTarget = 'tenant' | 'control-plane';
export const CONTROL_PLANE_ID = 'control-plane';
export const DUMP_SUFFIX = '.dump.enc';
export const SIDECAR_SUFFIX = '.manifest.json.enc';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A random lowercase [a-z0-9] token (keys, run ids, database names). */
export function randomToken(length: number, bytes: (n: number) => Buffer = randomBytes): string {
  const buf = bytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

/** The two backup ids an environment may use (§6.0: a whitelist, since a wrong value is consistent everywhere). */
export const BACKUP_ID_RE = /^(prod|staging)$/;

/**
 * The control-plane id: BACKUP_CONTROL_PLANE_ID when set (validated: `prod` or `staging`, else it throws), otherwise
 * sha256(direct host)[0:12]. Throws on an unparseable URL. main.ts resolves it once and passes it in every task's deps.
 */
export function controlPlaneId(controlPlaneUrl: string, env: Record<string, string | undefined> = process.env): string {
  const configured = env.BACKUP_CONTROL_PLANE_ID;
  if (configured !== undefined) {
    if (!BACKUP_ID_RE.test(configured)) throw new Error('BACKUP_CONTROL_PLANE_ID must be prod or staging');
    return configured;
  }
  const host = new URL(toDirectConnectionUrl(controlPlaneUrl)).hostname.toLowerCase();
  return createHash('sha256').update(host).digest('hex').slice(0, 12);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(d: Date): { ymd: string; hms: string; y: string; m: string; day: string } {
  const y = String(d.getUTCFullYear());
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  return { y, m, day, ymd: `${y}${m}${day}`, hms: `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` };
}

/** `ecs-<YYYYMMDDTHHMMSSZ>-<rand6>` (§6.4 "Run id"). Tests pass their own `test-…` ids instead. */
export function newRunId(now: Date, token = randomToken(6)): string {
  const s = stamp(now);
  return `ecs-${s.ymd}T${s.hms}Z-${token}`;
}

export function targetPrefix(cp: string, target: BackupTarget, id: string): string {
  return `v1/${cp}/${target}/${id}/`;
}

export function dumpKey(o: { cp: string; target: BackupTarget; id: string; now: Date; runId: string; token?: string }): string {
  const s = stamp(o.now);
  return `${targetPrefix(o.cp, o.target, o.id)}${s.y}/${s.m}/${s.day}/${o.runId}-${o.token ?? randomToken(8)}${DUMP_SUFFIX}`;
}

/** The S3 key without its suffix: the `key` value of both objects' encryption context (§6.5). */
export function baseKey(key: string): string {
  if (key.endsWith(DUMP_SUFFIX)) return key.slice(0, -DUMP_SUFFIX.length);
  if (key.endsWith(SIDECAR_SUFFIX)) return key.slice(0, -SIDECAR_SUFFIX.length);
  throw new Error('not a backup object key');
}

export function sidecarKeyFor(dumpObjectKey: string): string {
  return baseKey(dumpObjectKey) + SIDECAR_SUFFIX;
}

/** Restore-test databases carry their UTC creation time to the second (§6.6 step 6). */
export const RT_NAME_RE = /^rt_[0-9]{14}_[a-z0-9]{8}$/;

export function rtDatabaseName(now: Date, token = randomToken(8)): string {
  const s = stamp(now);
  return `rt_${s.ymd}${s.hms}_${token}`;
}

/** The creation time encoded in an `rt_…` name, or null when the name doesn't match the pattern. */
export function rtNameCreatedAt(name: string): Date | null {
  if (!RT_NAME_RE.test(name)) return null;
  const d = name.slice(3, 17);
  const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12), +d.slice(12, 14));
  return Number.isNaN(t) ? null : new Date(t);
}

/** The probe key a task may try to write (§6.13); expires under the 25-day rule if a write ever succeeds. */
export function probeKey(runId: string): string {
  return `v1/probe/${runId}`;
}
export const PROBE_MISSING_KEY = 'v1/probe/does-not-exist';
