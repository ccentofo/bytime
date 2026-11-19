import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { PgDialect } from 'drizzle-orm/pg-core';
import { timesheetEntries, users, costClasses } from '@/db/schema';
import { createWorkspaceZipStream, type ExportSnapshot } from '@/lib/export/workspace-export';
import { EXPORT_TABLES } from '@/lib/export/allowlists';

/**
 * SWEEP-FINDINGS.md A3-G1 (HIGH): the workspace export reads every table in keyset batches of 5,000 (`id > cursor ORDER BY
 * id LIMIT 5000`). With more than one batch, every row appears exactly once in its CSV, and manifest.json's rowCounts
 * equal the table's row count. Before this test, nothing caught an export that stopped after its first 5,000 rows.
 *
 * The snapshot is a fake that answers each `select … where … orderBy … limit n` like Postgres would: the rows whose id
 * sorts after the cursor (read from the rendered `gt(id, cursor)` condition), first `n`. No batch-size seam is needed.
 * Sizes: users 10,000 (exactly two full batches, then an empty read), cost_classes 5,001 (one row into the second batch),
 * timesheet_entries 12,345 (three batches; it feeds timesheet_entries.csv and timesheet_entries_current.csv).
 */

const dialect = new PgDialect();
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(6, '0')}`);

function fakeSnapshot(data: Map<unknown, string[]>) {
  const reads = new Map<unknown, number>();
  const select = () => {
    let table: unknown;
    let cond: unknown;
    let limit = Infinity;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => { table = t; return chain; },
      leftJoin: () => chain,
      where: (c: unknown) => { cond = c; return chain; },
      orderBy: () => chain,
      limit: (n: number) => { limit = n; return chain; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const n = (reads.get(table) ?? 0) + 1;
        reads.set(table, n);
        // A runaway loop (e.g. a cursor that doesn't advance) fails fast instead of reading forever.
        if (n > 10) return Promise.reject(new Error('too many batch reads for one table')).then(res, rej);
        const params = cond === undefined ? [] : dialect.sqlToQuery(cond as never).params;
        const cursor = params.length > 0 ? String(params[0]) : null;
        const all = data.get(table) ?? [];
        const rows = all.filter((id) => cursor === null || id > cursor).slice(0, limit).map((id) => ({ id }));
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return chain;
  };
  const conn = (async () => [{ exists: false }]) as unknown as ExportSnapshot['conn'];
  const close = vi.fn(async () => {});
  return { snapshot: { db: { select } as unknown as ExportSnapshot['db'], conn, close } as ExportSnapshot, reads, close };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const csvIds = (csv: string) => Papa.parse<string[]>(csv.replace(/^﻿/, ''), { skipEmptyLines: true }).data.slice(1).map((r) => r[0]);

describe('workspace export keyset pagination past one batch (A3-G1)', () => {
  it('every row exactly once in each CSV, and manifest rowCounts equal the table counts', async () => {
    const data = new Map<unknown, string[]>([
      [users, ids('u', 10_000)],
      [costClasses, ids('k', 5_001)],
      [timesheetEntries, ids('e', 12_345)],
    ]);
    const { snapshot, reads, close } = fakeSnapshot(data);
    const zip = await JSZip.loadAsync(await readAll(createWorkspaceZipStream(snapshot, { tenantSlug: 'acme-test' })));
    const file = async (name: string) => (await zip.file(name)!.async('string'));

    const expectExactly = (got: string[], want: string[]) => {
      expect(got.length).toBe(want.length);
      expect(new Set(got).size).toBe(want.length);
      expect(got).toEqual(want); // in id order, nothing skipped or repeated
    };
    expectExactly(csvIds(await file('users.csv')), ids('u', 10_000));
    expectExactly(csvIds(await file('cost_classes.csv')), ids('k', 5_001));
    expectExactly(csvIds(await file('timesheet_entries.csv')), ids('e', 12_345));
    expectExactly(csvIds(await file('timesheet_entries_current.csv')), ids('e', 12_345));

    const manifest = JSON.parse(await file('manifest.json')) as { rowCounts: Record<string, number> };
    expect(manifest.rowCounts.users).toBe(10_000);
    expect(manifest.rowCounts.cost_classes).toBe(5_001);
    expect(manifest.rowCounts.timesheet_entries).toBe(12_345);
    expect(manifest.rowCounts.timesheet_entries_current).toBe(12_345);
    // Every other table is empty, and listed as 0.
    for (const t of EXPORT_TABLES) if (!['users', 'cost_classes'].includes(t.file)) expect(manifest.rowCounts[t.file], t.file).toBe(0);

    // users: two full batches, then one empty read; cost_classes: a full batch and a short one (no third read).
    expect(reads.get(users)).toBe(3);
    expect(reads.get(costClasses)).toBe(2);
    expect(close).toHaveBeenCalledWith(true);
  }, 60_000);
});
