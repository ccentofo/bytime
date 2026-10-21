import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { sql, eq, and, gt, asc, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { requireAdminFresh } from '@/lib/session';
import { getTenantForExport } from '@/lib/tenant/context';
import { getDbForUrl } from '@/db';
import { users, chargeCodes, clins, slins, indirectChargeCodes, timesheetEntries } from '@/db/schema';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { EXPORT_TABLES, type ExportTableConfig } from '@/lib/export/allowlists';
import { buildManifest, buildReadme } from '@/lib/export/manifest';

/**
 * R8/T6: full workspace export. Every Customer Data table, every timesheet revision, streamed
 * out of the DB in batches so the whole table is never materialized in memory at once.
 * Admin-only, in every non-closed mode (D5/D6/D8).
 */

const BATCH_SIZE = 5000;
const BOM = '﻿';
type TenantDb = ReturnType<typeof getDbForUrl>;

function serializeValue(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number | boolean;
}

/** Keyset-paginated (by id, 5k rows/batch) export of one allowlisted table to a CSV string. */
async function exportSimpleTable(
  db: TenantDb,
  config: ExportTableConfig,
): Promise<{ csv: string; rowCount: number }> {
  const idColumn = (config.table as unknown as Record<string, any>).id;
  const header = Papa.unparse({ fields: config.columns.map((c) => c.header), data: [] });
  let body = '';
  let cursor: string | null = null;
  let rowCount = 0;

  for (;;) {
    const rows = (await db
      .select()
      .from(config.table)
      .where(cursor ? gt(idColumn, cursor) : undefined)
      .orderBy(asc(idColumn))
      .limit(BATCH_SIZE)) as unknown as Record<string, unknown>[];
    if (rows.length === 0) break;

    const records = rows.map((row) => config.columns.map((c) => serializeValue(row[c.key as string])));
    body += Papa.unparse(records, { header: false }) + '\n';
    rowCount += rows.length;
    cursor = String(rows[rows.length - 1].id);
    if (rows.length < BATCH_SIZE) break;
  }

  return { csv: BOM + header + '\n' + body, rowCount };
}

const TIMESHEET_HEADERS = [
  'id', 'user_id', 'user_email', 'user_full_name', 'entry_date', 'hours', 'revision_number',
  'change_reason_code', 'comment', 'created_at', 'created_by', 'created_by_email',
  'charge_code_id', 'charge_code', 'charge_code_name', 'clin_id', 'clin_number', 'slin_id',
  'slin_number', 'indirect_code_id', 'indirect_code', 'indirect_code_name',
] as const;

const createdByUsers = alias(users, 'created_by_users');

/** T6: timesheet_entries needs resolved human labels and a latest-revision-only variant, so it
 * isn't a plain column projection like the rest of EXPORT_TABLES. */
async function exportTimesheetEntries(db: TenantDb): Promise<{
  raw: { csv: string; rowCount: number };
  current: { csv: string; rowCount: number };
}> {
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
  };
  const keys = Object.keys(projection) as (keyof typeof projection)[];

  // Latest-revision-per-cell: same correlated-subquery pattern as
  // src/server/internal/reports.ts's getDetailedCostReportData.
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

  async function run(extraCondition: SQL | null): Promise<{ csv: string; rowCount: number }> {
    let cursor: string | null = null;
    let rowCount = 0;
    let body = '';

    for (;;) {
      const conditions: SQL[] = [];
      if (cursor) conditions.push(gt(timesheetEntries.id, cursor));
      if (extraCondition) conditions.push(extraCondition);
      const rows = await db
        .select(projection)
        .from(timesheetEntries)
        .leftJoin(users, eq(timesheetEntries.userId, users.id))
        .leftJoin(createdByUsers, eq(timesheetEntries.createdBy, createdByUsers.id))
        .leftJoin(chargeCodes, eq(timesheetEntries.chargeCodeId, chargeCodes.id))
        .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
        .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
        .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(timesheetEntries.id))
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;

      const records = rows.map((row) => keys.map((k) => serializeValue((row as Record<string, unknown>)[k])));
      body += Papa.unparse(records, { header: false }) + '\n';
      rowCount += rows.length;
      cursor = String(rows[rows.length - 1].id);
      if (rows.length < BATCH_SIZE) break;
    }

    const header = Papa.unparse({ fields: [...TIMESHEET_HEADERS], data: [] });
    return { csv: BOM + header + '\n' + body, rowCount };
  }

  const raw = await run(null);
  const current = await run(currentRevisionOnly);
  return { raw, current };
}

/** The latest applied migration count/timestamp, for manifest.json. Mirrors the query already
 * proven in src/lib/tenant/migrate-tenant.ts's getPendingMigrationCount. */
async function getSchemaMigrationInfo(db: TenantDb): Promise<{ count: number; lastAppliedAt: Date | null }> {
  try {
    const rows = await db.execute(
      sql`select count(*)::int as count, max(created_at) as last from drizzle.__drizzle_migrations`,
    );
    const row = (rows as unknown as Array<{ count: number; last: string | number | null }>)[0];
    return { count: row?.count ?? 0, lastAppliedAt: row?.last ? new Date(Number(row.last)) : null };
  } catch (err) {
    if ((err as { code?: string })?.code === '42P01') return { count: 0, lastAppliedAt: null };
    throw err;
  }
}

export async function GET() {
  const actor = await requireAdminFresh();
  const tenant = await getTenantForExport();

  const rate = checkRateLimit(`export:${tenant.slug}`, 5, 60 * 60 * 1000);
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterMs);

  const db = getDbForUrl(tenant.dbUrl);
  const zip = new JSZip();
  const rowCounts: Record<string, number> = {};

  for (const config of EXPORT_TABLES) {
    const { csv, rowCount } = await exportSimpleTable(db, config);
    zip.file(`${config.file}.csv`, csv);
    rowCounts[config.file] = rowCount;
  }

  const { raw, current } = await exportTimesheetEntries(db);
  zip.file('timesheet_entries.csv', raw.csv);
  zip.file('timesheet_entries_current.csv', current.csv);
  rowCounts.timesheet_entries = raw.rowCount;
  rowCounts.timesheet_entries_current = current.rowCount;

  const { count, lastAppliedAt } = await getSchemaMigrationInfo(db);
  const manifest = buildManifest({
    tenantSlug: tenant.slug,
    schemaMigrationCount: count,
    schemaMigrationLastAppliedAt: lastAppliedAt,
    rowCounts,
  });
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('README.md', buildReadme(manifest));

  console.log(`workspace export: tenant=${tenant.slug} admin=${actor.id} rows=${JSON.stringify(rowCounts)}`);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${tenant.slug}-export-${new Date().toISOString().slice(0, 10)}.zip"`,
    },
  });
}
