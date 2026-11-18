/**
 * The system Neon project names (feature-plan-control-plane-disaster.md §6.11): one exported builder and one exact regex
 * per name, tested round trip. They use 3c's 14-digit UTC stamp (yyyymmddhhmmss) and a try number, so retries within one
 * minute get distinct names. `src/lib/tenant/slug-rules.ts` reserves the matching slug parts (it mirrors these patterns
 * rather than importing this file, so the app's bundle never reaches into scripts/; approved detail D9).
 */
import { isValidSlug } from '../../../src/lib/tenant/slug-rules';

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** 3c workspace rebuild: `cadenzpoint-r-<tenant id first 8>-<yyyymmddhhmmss>-<try>` (≤ 40 characters; moved here unchanged). */
export const rebuildName = (tenantId: string, now: Date, tryNo: number) => `cadenzpoint-r-${tenantId.slice(0, 8)}-${stamp(now)}-${tryNo}`;
export const REBUILD_NAME_RE = /^cadenzpoint-r-[0-9a-f]{8}-\d{14}-\d+$/;

/** Control-plane rebuild (§6.3 step 6). */
export const controlPlaneRebuildName = (now: Date, tryNo: number) => `cadenzpoint-control-r${stamp(now)}-${tryNo}`;
export const CONTROL_PLANE_REBUILD_NAME_RE = /^cadenzpoint-control-r\d{14}-\d+$/;

/** Control-plane rehearsal copy (§6.5 step 3). */
export const controlPlaneRehearsalName = (now: Date, tryNo: number) => `cadenzpoint-rehearse-cp-${stamp(now)}-${tryNo}`;
export const CONTROL_PLANE_REHEARSAL_NAME_RE = /^cadenzpoint-rehearse-cp-\d{14}-\d+$/;

/** 3c's canary (feature-plan-disaster-restore.md §6.5). */
export const CANARY_PROJECT_NAME = 'cadenzpoint-recoverable-canary';

export type WindowProjectType = 'rebuild' | 'signup' | 'other';

/**
 * §6.4 R4's type of a project created in the window: a 3c rebuild name (checked first: `cadenzpoint-r-…` is also a
 * well-formed slug name), then a workspace signup `cadenzpoint-<slug>` with a valid slug, else other.
 */
export function windowProjectType(name: string): { type: WindowProjectType; slug: string | null } {
  if (REBUILD_NAME_RE.test(name)) return { type: 'rebuild', slug: null };
  const m = /^cadenzpoint-(.+)$/.exec(name);
  if (m && isValidSlug(m[1])) return { type: 'signup', slug: m[1] };
  return { type: 'other', slug: null };
}
