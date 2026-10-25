import postgres, { type ReservedSql, type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import Papa from 'papaparse';
import { Zip, ZipDeflate } from 'fflate';
import { users, chargeCodes, clins, slins, indirectChargeCodes, timesheetEntries, importBatches } from '@/db/schema';
import { provenanceText } from '@/lib/provenance';
import { EXPORT_TABLES, type ExportTableConfig } from './allowlists';
import { buildManifest, buildReadme, TIMESHEET_COLUMNS } from './manifest';
import { FORMULA_PATTERN } from '@/lib/csv/escape';

/** Formula-injection guard (one definition: src/lib/csv/escape.ts), re-exported for the export's callers and tests. */
export { FORMULA_PATTERN };

/**
 * Full workspace export builder (feature-plan-terms-compliance-fixes.md §5.2, R8). Used by the export route and
 * `tenant:export`. Takes an explicit connection — no `headers()`, `getDb()`, session or `next/*` here.
 *
 * - One consistent snapshot: a dedicated connection to the tenant's DIRECT host, `BEGIN ISOLATION LEVEL
 *   REPEATABLE READ READ ONLY`, keyset-paginated reads (5,000 rows) pulled lazily as the consumer reads.
 * - fflate `Zip` + `ZipDeflate`, one file at a time; aborts before the zip limits (no Zip64).
 * - On ANY error after the first byte: the archive is never finalized (`zip.end()` is not called), so it has
 *   no central directory and cannot be opened — a truncated export can never pass for a complete one.
 */

const BATCH_SIZE = 5000;
const BOM = '﻿';
const CRLF = '\r\n';
const MAX_ENTRIES = 65_000;            // zip limit 65,535 without Zip64
const MAX_BYTES = 4 * 1024 ** 3 - 64 * 1024 ** 2; // stay under 4 GiB (no Zip64), with headroom for headers

type ExportDb = ReturnType<typeof drizzle>;

export interface ExportSnapshot {
  db: ExportDb;
  conn: ReservedSql;
  /** COMMIT (success) or ROLLBACK, release the connection and end the client. Idempotent. */
  close(commit: boolean): Promise<void>;
}

/** Same rule as migrate-tenant's toDirectConnectionUrl: strip `-pooler` from the first host label. */
function directUrl(url: string): string {
  const u = new URL(url);
  const [first, ...rest] = u.hostname.split('.');
  if (first.endsWith('-pooler')) u.hostname = [first.slice(0, -'-pooler'.length), ...rest].join('.');
  return u.toString();
}

export async function openExportSnapshot(tenantDbUrl: string): Promise<ExportSnapshot> {
  const client: Sql = postgres(directUrl(tenantDbUrl), { max: 1 });
  let conn: ReservedSql;
  try {
    conn = await client.reserve();
  } catch (err) {
    await client.end({ timeout: 5 });
    throw err;
  }
  let closed = false;
  const close = async (commit: boolean) => {
    if (closed) return;
    closed = true;
    try {
      await conn.unsafe(commit ? 'COMMIT' : 'ROLLBACK');
    } catch {
      /* connection may already be broken */
    }
    conn.release();
    await client.end({ timeout: 5 });
  };
  try {
    await conn.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // A reserved postgres-js handle has no `.options`, which drizzle's constructor writes its type parsers into.
    // Share the parent client's options (connections read parsers from that same object), so queries on `conn`
    // get drizzle's date handling. Constructed inside the try: a failure here must still ROLLBACK and release.
    const db = drizzle(Object.assign(conn, { options: client.options }) as unknown as Sql);
    return { db, conn, close };
  } catch (err) {
    await close(false);
    throw err;
  }
}

function serializeValue(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number | boolean;
}

export function csvHeader(headers: readonly string[]): string {
  return BOM + Papa.unparse([headers as string[]]) + CRLF;
}

export function csvRows(rows: Array<Array<string | number | boolean>>): string {
  return Papa.unparse(rows, { newline: CRLF, escapeFormulae: FORMULA_PATTERN }) + CRLF;
}

type CsvSource = { name: string; produce: () => AsyncGenerator<string> };

function tableSource(db: ExportDb, config: ExportTableConfig, counts: Record<string, number>): CsvSource {
  return {
    name: `${config.file}.csv`,
    async *produce() {
      const tableColumns = config.table as unknown as Record<string, Parameters<typeof gt>[0]>;
      const idColumn = tableColumns.id;
      // Read only the allowlisted columns: secret columns never even leave the database.
      const projection = Object.fromEntries(config.columns.map((c) => [c.key, c.expr ?? tableColumns[c.key]]));
      counts[config.file] = 0;
      yield csvHeader(config.columns.map((c) => c.header));
      let cursor: unknown = null;
      for (;;) {
        const rows = (await db.select(projection as never).from(config.table)
          .where(cursor !== null ? gt(idColumn, cursor) : undefined)
          .orderBy(asc(idColumn))
          .limit(BATCH_SIZE)) as unknown as Record<string, unknown>[];
        if (rows.length === 0) break;
        yield csvRows(rows.map((row) => config.columns.map((c) => serializeValue(row[c.key]))));
        counts[config.file] += rows.length;
        cursor = rows[rows.length - 1].id;
        if (rows.length < BATCH_SIZE) break;
      }
    },
  };
}

const createdByUsers = alias(users, 'created_by_users');
const importerUsers = alias(users, 'importer_users');

function timesheetSource(db: ExportDb, file: string, currentOnly: boolean, counts: Record<string, number>): CsvSource {
  const projection = {
    id: timesheetEntries.id,
    userId: timesheetEntries.userId,
    userEmail: users.email,
    userFullName: users.fullName,
    entryDate: timesheetEntries.entryDate,
    hours: timesheetEntries.hours,
    revisionNumber: timesheetEntries.revisionNumber,
    changeReasonCode: timesheetEntries.changeReasonCode,
    comment: timesheetEntries.comment,
    createdAt: timesheetEntries.createdAt,
    createdBy: timesheetEntries.createdBy,
    createdByEmail: createdByUsers.email,
    chargeCodeId: timesheetEntries.chargeCodeId,
    chargeCode: chargeCodes.code,
    chargeCodeName: chargeCodes.name,
    clinId: timesheetEntries.clinId,
    clinNumber: clins.clinNumber,
    slinId: timesheetEntries.slinId,
    slinNumber: slins.slinNumber,
    indirectCodeId: timesheetEntries.indirectCodeId,
    indirectCode: indirectChargeCodes.code,
    indirectCodeName: indirectChargeCodes.name,
    // certified-outputs C1/C8: provenance (insert-time) + the display label; the import batch columns only feed the label.
    source: timesheetEntries.source,
    importBatchId: timesheetEntries.importBatchId,
    originalMetadata: timesheetEntries.originalMetadata,
    importSourceSystem: importBatches.sourceSystem,
    importedAt: importBatches.importedAt,
    importedByName: importerUsers.fullName,
  };
  type Row = { [K in keyof typeof projection]: unknown };
  // Output order = TIMESHEET_COLUMNS; `provenance` is derived from the row (src/lib/provenance.ts).
  const out: Array<(row: Row) => unknown> = [
    (r) => r.id, (r) => r.userId, (r) => r.userEmail, (r) => r.userFullName, (r) => r.entryDate, (r) => r.hours,
    (r) => r.revisionNumber, (r) => r.changeReasonCode, (r) => r.comment, (r) => r.createdAt, (r) => r.createdBy,
    (r) => r.createdByEmail, (r) => r.chargeCodeId, (r) => r.chargeCode, (r) => r.chargeCodeName, (r) => r.clinId,
    (r) => r.clinNumber, (r) => r.slinId, (r) => r.slinNumber, (r) => r.indirectCodeId, (r) => r.indirectCode,
    (r) => r.indirectCodeName, (r) => r.source, (r) => r.importBatchId, (r) => r.originalMetadata,
    (r) => provenanceText({
      source: r.source as string, changeReasonCode: r.changeReasonCode as string | null, originalMetadata: r.originalMetadata,
      importSourceSystem: r.importSourceSystem as string | null, importedAt: r.importedAt as Date | null, importedByName: r.importedByName as string | null,
    }),
  ];
  // Latest revision per cell; cell identity matches entries_user_code_date_rev_unique_idx.
  const currentRevisionOnly = eq(
    timesheetEntries.revisionNumber,
    sql`(
      SELECT MAX(te2.revision_number)
      FROM timesheet_entries te2
      WHERE te2.user_id = ${timesheetEntries.userId}
        AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
        AND te2.entry_date = ${timesheetEntries.entryDate}
    )`,
  );
  return {
    name: `${file}.csv`,
    async *produce() {
      counts[file] = 0;
      yield csvHeader(TIMESHEET_COLUMNS.map((c) => c.header));
      let cursor: string | null = null;
      for (;;) {
        const conditions: SQL[] = [];
        if (cursor) conditions.push(gt(timesheetEntries.id, cursor));
        if (currentOnly) conditions.push(currentRevisionOnly);
        const rows = await db.select(projection).from(timesheetEntries)
          .leftJoin(users, eq(timesheetEntries.userId, users.id))
          .leftJoin(createdByUsers, eq(timesheetEntries.createdBy, createdByUsers.id))
          .leftJoin(chargeCodes, eq(timesheetEntries.chargeCodeId, chargeCodes.id))
          .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
          .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
          .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
          .leftJoin(importBatches, eq(timesheetEntries.importBatchId, importBatches.id))
          .leftJoin(importerUsers, eq(importBatches.importedBy, importerUsers.id))
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(asc(timesheetEntries.id))
          .limit(BATCH_SIZE);
        if (rows.length === 0) break;
        yield csvRows(rows.map((row) => out.map((f) => serializeValue(f(row as Row)))));
        counts[file] += rows.length;
        cursor = String(rows[rows.length - 1].id);
        if (rows.length < BATCH_SIZE) break;
      }
    },
  };
}

/** Applied migrations, read first: `to_regclass` avoids a 42P01 that would abort the snapshot transaction. */
async function migrationInfo(conn: ReservedSql): Promise<{ count: number; lastAppliedAt: Date | null }> {
  const [{ exists }] = await conn<{ exists: boolean }[]>`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`;
  if (!exists) return { count: 0, lastAppliedAt: null };
  const [row] = await conn<{ count: number; last: string | number | null }[]>`
    SELECT count(*)::int AS count, max(created_at) AS last FROM drizzle.__drizzle_migrations`;
  return { count: row?.count ?? 0, lastAppliedAt: row?.last ? new Date(Number(row.last)) : null };
}

export interface WorkspaceZipOptions {
  tenantSlug: string;
  signal?: AbortSignal;
  /** Called once with the error that aborted the archive (route: Sentry). */
  onError?: (err: unknown) => void;
  /** Called once after a complete archive (row counts). */
  onComplete?: (rowCounts: Record<string, number>) => void;
}

/**
 * The export as a pull-based ReadableStream: each pull advances one batch. Owns the snapshot: closes it on
 * completion (COMMIT), error, cancel() or `signal` abort (ROLLBACK).
 */
export function createWorkspaceZipStream(snapshot: ExportSnapshot, opts: WorkspaceZipOptions): ReadableStream<Uint8Array> {
  const counts: Record<string, number> = {};
  const sources: CsvSource[] = [
    ...EXPORT_TABLES.map((t) => tableSource(snapshot.db, t, counts)),
    timesheetSource(snapshot.db, 'timesheet_entries', false, counts),
    timesheetSource(snapshot.db, 'timesheet_entries_current', true, counts),
  ];
  const encoder = new TextEncoder();
  const queue: Uint8Array[] = [];
  let zipError: unknown = null;
  let outBytes = 0;
  const zip = new Zip((err, data) => {
    if (err) { zipError = err; return; }
    outBytes += data.length;
    queue.push(data);
  });

  let migrations: { count: number; lastAppliedAt: Date | null } | null = null;
  // Each entry's UNCOMPRESSED size is a 32-bit field too (fflate has no Zip64): track it per entry.
  let current: { file: ZipDeflate; gen: AsyncGenerator<string>; bytes: number } | null = null;
  let nextSource = 0;
  let entries = 0;
  let finished = false;
  let failed = false;

  const addWholeFile = (name: string, content: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    entries++;
    f.push(encoder.encode(content), true);
  };

  async function step(): Promise<void> {
    if (migrations === null) {
      migrations = await migrationInfo(snapshot.conn);
      return;
    }
    if (!current) {
      if (nextSource >= sources.length) {
        const manifest = buildManifest({
          tenantSlug: opts.tenantSlug,
          schemaMigrationCount: migrations.count,
          schemaMigrationLastAppliedAt: migrations.lastAppliedAt,
          rowCounts: counts,
        });
        addWholeFile('README.md', buildReadme(manifest));
        addWholeFile('manifest.json', JSON.stringify(manifest, null, 2)); // written last
        zip.end();
        finished = true;
        return;
      }
      const src = sources[nextSource++];
      if (entries + 3 > MAX_ENTRIES) throw new Error('Export exceeds the zip entry limit; use tenant:export.');
      const file = new ZipDeflate(src.name, { level: 6 });
      zip.add(file);
      entries++;
      current = { file, gen: src.produce(), bytes: 0 };
      return;
    }
    const r = await current.gen.next();
    if (r.done) {
      current.file.push(new Uint8Array(0), true);
      current = null;
    } else {
      const chunk = encoder.encode(r.value);
      current.bytes += chunk.length;
      if (current.bytes > MAX_BYTES) throw new Error(`${current.file.filename} exceeds 4 GiB uncompressed (zip limit); use tenant:export.`);
      current.file.push(chunk);
    }
    if (zipError) throw zipError;
    if (outBytes > MAX_BYTES) throw new Error('Export exceeds 4 GiB (zip limit); use tenant:export.');
  }

  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, err: unknown) => {
    if (failed) return;
    failed = true;
    queue.length = 0;
    try { zip.terminate(); } catch { /* ignore */ }
    await snapshot.close(false);
    opts.onError?.(err);
    controller.error(err); // never zip.end(): no central directory, so the partial archive won't open
  };

  const onAbort = () => { void snapshot.close(false); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (queue.length === 0 && !finished) {
          if (opts.signal?.aborted) throw new Error('Export aborted by the client.');
          await step();
        }
        while (queue.length > 0) controller.enqueue(queue.shift()!);
        if (finished) {
          opts.signal?.removeEventListener('abort', onAbort);
          await snapshot.close(true);
          opts.onComplete?.({ ...counts });
          controller.close();
        }
      } catch (err) {
        opts.signal?.removeEventListener('abort', onAbort);
        await fail(controller, err);
      }
    },
    async cancel() {
      opts.signal?.removeEventListener('abort', onAbort);
      failed = true;
      try { zip.terminate(); } catch { /* ignore */ }
      await snapshot.close(false);
    },
  }, { highWaterMark: 0 });
}
