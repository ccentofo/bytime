/**
 * The hourly export sweep (feature-plan-cloud-export.md §6.7; image command `export sweep`, task family
 * `cadenzpoint-backup-sweep`, the export task role). Row-driven, and runnable from any caller: it only erases delivery
 * copies whose links can no longer work, and delivery orphans. It never deletes a hold copy.
 *
 *  0. Any control-plane read failing stops the sweep: the orphan steps never run on a lookup error, so an error can't be
 *     mistaken for "no row".
 *  1. Every delivery with `erased_at IS NULL AND (expires_at <= now() OR revoked_at IS NOT NULL)`: delete the object (an
 *     already-missing one counts as done), then set `erased_at`.
 *  2. Delivery orphans: objects under `delivery/` with no row, older than 1 day, are deleted (a task that died after its
 *     upload, or an "outcome unknown" record that never committed).
 *  3. Hold orphans: objects under `hold/` with no row, older than 1 day, are NOT deleted (a control-plane rollback may have
 *     lost a legal copy's row). Each raises `export-orphan-hold` (global, dedup = the key); the sweep resolves it once the
 *     key has a row or is gone.
 *
 * Logs carry ids and counts only (S3 keys contain the workspace slug).
 */
import postgres from 'postgres';
import { clientUrl } from './lib/pg-url';
import { summaryOf } from './lib/summarize-error';
import type { ExportStore } from './lib/export-store';
import { MINUTE, DAY } from './lib/util';

export const SWEEP_DEFAULTS = {
  deadlineMs: 15 * MINUTE,
  hardExitAfterDeadlineMs: 5 * MINUTE,
  orphanAgeMs: DAY,
  statementTimeoutMs: 60_000,
};

export const ORPHAN_HOLD_ALERT = 'export-orphan-hold';

export interface SweepDeps {
  controlPlaneUrl: string;
  store: ExportStore;
  log: (line: string) => void;
  now?: () => Date;
  deadlineMs?: number;
  hardExit?: (code: number) => void;
  hardExitAfterDeadlineMs?: number;
  orphanAgeMs?: number;
}

export interface SweepResult {
  exitCode: number;
  erased: number;
  orphansDeleted: number;
  orphanHolds: number;
  errors: number;
}

/** The id in `delivery/<id>/…` or `hold/<id>/…` (logs carry ids, never keys). */
export function idOfKey(key: string): string {
  return key.split('/')[1] ?? '?';
}

export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const log = deps.log;
  const now = deps.now ?? (() => new Date());
  const result: SweepResult = { exitCode: 0, erased: 0, orphansDeleted: 0, orphanHolds: 0, errors: 0 };
  const deadlineMs = deps.deadlineMs ?? SWEEP_DEFAULTS.deadlineMs;
  const orphanAgeMs = deps.orphanAgeMs ?? SWEEP_DEFAULTS.orphanAgeMs;
  let expired = false;
  const deadline = setTimeout(() => { expired = true; }, deadlineMs);
  const hardExit = setTimeout(() => {
    log('hard exit: the sweep is still running 5 minutes after its deadline');
    (deps.hardExit ?? ((c: number) => process.exit(c)))(1);
  }, deadlineMs + (deps.hardExitAfterDeadlineMs ?? SWEEP_DEFAULTS.hardExitAfterDeadlineMs));
  hardExit.unref?.();
  const cp = postgres(clientUrl(deps.controlPlaneUrl), {
    max: 1, connect_timeout: 30, onnotice: () => {}, connection: { statement_timeout: SWEEP_DEFAULTS.statementTimeoutMs },
  });
  const stop = (why: string): SweepResult => {
    log(`sweep stopped: ${why}`);
    result.errors++;
    result.exitCode = 1;
    return result;
  };
  try {
    log('export sweep started');
    // 1. Row-driven erasure.
    let due: Array<{ id: string; s3Key: string }>;
    try {
      due = await cp<{ id: string; s3Key: string }[]>`SELECT id::text AS id, s3_key AS "s3Key" FROM export_deliveries
        WHERE erased_at IS NULL AND (expires_at <= now() OR revoked_at IS NOT NULL) ORDER BY expires_at`;
    } catch (e) {
      return stop(`control-plane read failed (${summaryOf('control-plane', e)})`);
    }
    for (const d of due) {
      if (expired) return stop('deadline');
      try {
        await deps.store.delete(d.s3Key);
      } catch (e) {
        log(`delivery ${d.id}: the object could not be deleted (${summaryOf('s3', e)})`);
        result.errors++;
        continue;
      }
      try {
        await cp`UPDATE export_deliveries SET erased_at = now() WHERE id = ${d.id} AND erased_at IS NULL`;
      } catch (e) {
        return stop(`control-plane write failed (${summaryOf('control-plane', e)})`);
      }
      result.erased++;
      log(`delivery ${d.id} erased`);
    }

    // 2–3. Orphans: every known key first (a failed read stops before any orphan step).
    let deliveryKeys: Set<string>;
    let holdKeys: Set<string>;
    try {
      deliveryKeys = new Set((await cp<{ k: string }[]>`SELECT s3_key AS k FROM export_deliveries`).map((r) => r.k));
      holdKeys = new Set((await cp<{ k: string }[]>`SELECT s3_key AS k FROM export_holds`).map((r) => r.k));
    } catch (e) {
      return stop(`control-plane read failed (${summaryOf('control-plane', e)})`);
    }
    const cutoff = now().getTime() - orphanAgeMs;

    try {
      for (const o of await deps.store.list('delivery/')) {
        if (expired) return stop('deadline');
        if (deliveryKeys.has(o.key) || o.lastModified.getTime() > cutoff) continue;
        try {
          await deps.store.delete(o.key);
          result.orphansDeleted++;
          log(`delivery orphan ${idOfKey(o.key)} deleted`);
        } catch (e) {
          log(`delivery orphan ${idOfKey(o.key)}: could not be deleted (${summaryOf('s3', e)})`);
          result.errors++;
        }
      }
    } catch (e) {
      log(`delivery/ could not be listed (${summaryOf('s3', e)})`);
      result.errors++;
    }

    let holdObjects: Set<string> | null = null;
    try {
      const listed = await deps.store.list('hold/');
      holdObjects = new Set(listed.map((o) => o.key));
      const at = now();
      for (const o of listed) {
        if (holdKeys.has(o.key) || o.lastModified.getTime() > cutoff) continue;
        await cp`INSERT INTO ops_alerts (scope, tenant_id, kind, dedup_key, detail, first_seen_at, last_seen_at)
          VALUES ('global', NULL, ${ORPHAN_HOLD_ALERT}, ${o.key}, ${cp.json({ holdId: idOfKey(o.key), lastModified: o.lastModified.toISOString(), bytes: o.size })}, ${at}, ${at})
          ON CONFLICT (scope, kind, dedup_key) WHERE resolved_at IS NULL
          DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, occurrences = ops_alerts.occurrences + 1, detail = EXCLUDED.detail`;
        result.orphanHolds++;
        log(`hold orphan ${idOfKey(o.key)}: ${ORPHAN_HOLD_ALERT} raised (kept)`);
      }
    } catch (e) {
      log(`hold/ could not be checked (${summaryOf('hold', e)})`);
      result.errors++;
    }

    // Resolve the orphan alerts whose key now has a row, or is gone (only when hold/ was listed).
    if (holdObjects) {
      try {
        const open = await cp<{ id: string; key: string }[]>`SELECT id::text AS id, dedup_key AS key FROM ops_alerts
          WHERE kind = ${ORPHAN_HOLD_ALERT} AND resolved_at IS NULL`;
        for (const a of open) {
          if (holdKeys.has(a.key) || !holdObjects.has(a.key)) {
            await cp`UPDATE ops_alerts SET resolved_at = now(), resolution_note = ${holdKeys.has(a.key) ? 'the hold has a row' : 'the object is gone'}
              WHERE id = ${a.id} AND resolved_at IS NULL`;
            log(`hold orphan ${idOfKey(a.key)}: resolved`);
          }
        }
      } catch (e) {
        log(`the orphan alerts could not be resolved (${summaryOf('control-plane', e)})`);
        result.errors++;
      }
    }
    if (result.errors > 0) result.exitCode = 1;
    log(`export sweep finished: ${result.erased} erased, ${result.orphansDeleted} delivery orphan(s) deleted, ${result.orphanHolds} hold orphan(s) reported, ${result.errors} error(s)`);
    return result;
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardExit);
    await cp.end({ timeout: 5 }).catch(() => {});
  }
}
