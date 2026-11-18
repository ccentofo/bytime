/**
 * The window reconcile (feature-plan-control-plane-disaster.md §6.4). Filled in by C4.
 */
import type postgres from 'postgres';
import type { DisasterDeps } from './disaster';

export interface ReconcileInput {
  /** The control plane to reconcile: the new one (mode control-plane), the live one (mode reconcile) or the rehearsal copy. */
  cp: postgres.Sql;
  /** Its direct host (R2's guard: a chain end may never be the control plane's host). */
  cpDirectHost: string;
  windowStart: Date;
  windowEnd: Date;
  runId: string;
  deps: DisasterDeps;
  /** §6.5: R2 resolves without switching, R4 raises nothing; R3's proof rows go into `cp` (the copy). */
  dryRun: boolean;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  signal: AbortSignal;
  /** The old and new control-plane project ids (R4 excludes them; R1's positive control may use them). */
  controlPlaneProjectIds: string[];
}

export interface ReconcileResult {
  r1Failed: boolean;
  counts: Record<string, number>;
  /** The run row's summary part (counts per class). */
  summary: Record<string, unknown>;
  /** Email lines (may name slugs: the topic is private). */
  email: string[];
}

export async function runReconcile(input: ReconcileInput): Promise<ReconcileResult> {
  throw new Error(`the reconcile is not in this build (run ${input.runId})`);
}
