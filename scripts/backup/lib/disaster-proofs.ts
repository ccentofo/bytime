/**
 * The disaster button's proof rules (feature-plan-disaster-restore.md §6.0, §6.4 step 2), shared by the deploy path
 * (scripts/lib/migrate-all-run.ts, `--skip-lost`) and the disaster task (scripts/backup/disaster.ts). Pure: no imports,
 * no I/O. Lives under scripts/backup/ because the backup image bundles it.
 *
 * A `proof` row records what a press (or a deploy) observed about a workspace's ORIGINAL database. Only DECISIVE rows
 * supersede each other; the transient ones (`refused:proof-failed`, `refused:network-unproven`, `refused:original-exists`,
 * `refused:recoverable`, `rehearse-ok`) never do.
 */

/** Proof statuses that let `--skip-lost` skip a workspace whose database doesn't connect (any age). */
export const SKIPPABLE_PROOFS = [
  'gone', 'unreachable-4h', 'observed-unreachable', 'refused:credentials', 'refused:database-missing',
] as const;

/** Decisive proof statuses: the newest of these is the workspace's current proof. */
export const DECISIVE_PROOFS = [...SKIPPABLE_PROOFS, 'reachable-again', 'refused:reachable'] as const;

export interface TenantDisasterFacts {
  /** The newest decisive proof row, or null. */
  proof: { status: string; at: Date } | null;
  /** The newest `linked` row (a rebuild switched the workspace). */
  linkedAt: Date | null;
  /** The newest `skip`-kind row with status `skipped`. */
  skippedAt: Date | null;
  /** The newest `skip`-kind row with status `migrated`. */
  migratedAt: Date | null;
  /** The newest 3b `ok` backup's finished_at. */
  lastOkAt: Date | null;
}

export const NO_FACTS: TenantDisasterFacts = { proof: null, linkedAt: null, skippedAt: null, migratedAt: null, lastOkAt: null };

const after = (a: Date | null, b: Date) => a !== null && a.getTime() > b.getTime();

/**
 * §6.0 conditions 1–2: the newest decisive proof is skippable, no `linked` row is newer, and no 3b `ok` backup finished
 * after it. (Condition 3, "this deploy's pendingCount throws", is the caller's.)
 */
export function hasLiveProof(f: TenantDisasterFacts): boolean {
  if (!f.proof) return false;
  if (!(SKIPPABLE_PROOFS as readonly string[]).includes(f.proof.status)) return false;
  return !after(f.linkedAt, f.proof.at) && !after(f.lastOkAt, f.proof.at);
}

/** §6.0: a `migrated` row is due when the newest `skipped` row or the newest `linked` row is newer than the newest `migrated`. */
export function needsMigratedRow(f: TenantDisasterFacts): boolean {
  const newest = [f.skippedAt, f.linkedAt].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0];
  if (!newest) return false;
  return f.migratedAt === null || newest.getTime() > f.migratedAt.getTime();
}

/** The deploy's printed text for a skipped workspace (uuid only: the deploy log is public). */
export const SKIPPED_DETAIL = 'skipped (proven lost, awaiting rebuild)';
export const RECONNECTED_DETAIL = 'reachable again; re-run the deploy';
