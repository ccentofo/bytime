import type { ActionResult } from '@/lib/action-result';
import type { RunResult } from '@/lib/run-action';
import { splitMigrationBatches } from './import-plan';

/**
 * Client-side driver for multi-batch migration validation and import (feature-plan-certified-outputs.md C1 "Batch
 * limits"). Splits the file (≤ 2,000 rows, ≤ 200 employees, ~800 KB per batch — under Next's 1 MB server-action body
 * limit), sends the batches one at a time, and stops at the first refused batch (e.g. the import window closed partway
 * through), reporting which batches committed and which rows remain. Row numbers are file-wide (1-based).
 */

export interface BatchOutcome<R> {
  index: number;      // 1-based batch number
  firstRow: number;   // file-wide row number of the batch's first row
  lastRow: number;
  result: R;
}

export interface BatchRunReport<R> {
  completed: BatchOutcome<R>[];
  stopped: null | { index: number; firstRow: number; lastRow: number; message: string; remainingRows: number };
  totalBatches: number;
}

export async function runMigrationBatches<T, R>(
  rows: T[],
  employeeOf: (row: T) => string,
  send: (batch: T[]) => Promise<ActionResult<R>>,
): Promise<BatchRunReport<R>> {
  const batches = splitMigrationBatches(rows, employeeOf);
  const completed: BatchOutcome<R>[] = [];
  let firstRow = 1;
  for (const [i, batch] of batches.entries()) {
    const lastRow = firstRow + batch.length - 1;
    let outcome: RunResult<R>;
    try {
      outcome = await send(batch);
    } catch {
      outcome = { ok: false, code: 'unexpected', error: 'Something went wrong. Please try again.' };
    }
    if (!outcome.ok) {
      return {
        completed,
        stopped: { index: i + 1, firstRow, lastRow, message: outcome.error, remainingRows: rows.length - firstRow + 1 },
        totalBatches: batches.length,
      };
    }
    completed.push({ index: i + 1, firstRow, lastRow, result: outcome.data });
    firstRow = lastRow + 1;
  }
  return { completed, stopped: null, totalBatches: batches.length };
}

/** Shift batch-local row numbers (1-based) to file-wide ones. */
export function toFileRow(batchFirstRow: number, batchRow: number): number {
  return batchFirstRow + batchRow - 1;
}
