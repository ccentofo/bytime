import 'server-only';
import { and, asc, count, eq, gte, isNull, sql, sum } from 'drizzle-orm';
import { exportDeliveries, exportHolds, tenantNotices } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { raiseAlert, resolveAlert } from './lifecycle-store';

/**
 * The export findings and the digest's export lines (feature-plan-cloud-export.md §6.7), run by the daily digest
 * (ops-digest.ts). Their own raise and resolve: NOT 3b's syncBackupAlerts (whose sweep would auto-resolve them; its
 * prefixes are `backup-` and `restore-test-`).
 *
 * - `export-copy-overdue`: a delivery copy still not erased 6 hours after its link stopped working (expiry or revoke):
 *   the hourly sweep is failing. Because the digest runs daily, "after 6 hours" means the first digest at least 6 hours
 *   after expiry (up to about 30 hours). Resolved when none remain.
 * - `export-download-misconfigured` is raised and resolved by the download page (src/lib/export/download-url.ts).
 * - `export-orphan-hold` is raised and resolved by the hourly sweep (scripts/backup/export-sweep.ts), the only job that
 *   can list S3.
 */

export const EXPORT_COPY_OVERDUE = 'export-copy-overdue';
const OVERDUE_HOURS = 6;
const DAY_MS = 24 * 3600_000;

/** Raise or resolve `export-copy-overdue` (global; deduplicated). Exported for T12. */
export async function checkExportCopies(now: Date): Promise<{ overdue: number }> {
  return withLockedPool(async (db) => {
    const cutoff = new Date(now.getTime() - OVERDUE_HOURS * 3600_000);
    const rows = await db.select({ id: exportDeliveries.id, endedAt: sql<Date>`LEAST(COALESCE(${exportDeliveries.revokedAt}, ${exportDeliveries.expiresAt}), ${exportDeliveries.expiresAt})` })
      .from(exportDeliveries)
      .where(and(
        isNull(exportDeliveries.erasedAt),
        sql`LEAST(COALESCE(${exportDeliveries.revokedAt}, ${exportDeliveries.expiresAt}), ${exportDeliveries.expiresAt}) < ${cutoff.toISOString()}::timestamptz`,
      ))
      .orderBy(asc(exportDeliveries.expiresAt));
    const alert = { tenantId: null, kind: EXPORT_COPY_OVERDUE };
    if (rows.length > 0) {
      await raiseAlert(db, { ...alert, detail: { count: rows.length, oldestDeliveryId: rows[0].id } }, now);
    } else {
      await resolveAlert(db, alert, now);
    }
    return { overdue: rows.length };
  });
}

export interface ExportDigest {
  /** The daily line (always present). */
  line: string;
  /** On UTC day 1: every open hold (hold id, workspace id, age, reason). Empty on other days. */
  holds: Array<{ holdId: string; tenantId: string; ageDays: number; reason: string }>;
}

/** The digest's export line, and the monthly open-hold list on UTC day 1 (exported for T12). */
export async function exportDigest(now: Date): Promise<ExportDigest> {
  return withLockedPool(async (db) => {
    const since = new Date(now.getTime() - 7 * DAY_MS);
    const [recent] = await db.select({ delivered: count(), downloads: sum(exportDeliveries.downloadCount) })
      .from(exportDeliveries).where(gte(exportDeliveries.createdAt, since));
    const [pending] = await db.select({ n: count() })
      .from(exportDeliveries)
      .innerJoin(tenantNotices, eq(tenantNotices.id, exportDeliveries.noticeId))
      .where(and(gte(exportDeliveries.createdAt, since), isNull(tenantNotices.sentAt), isNull(tenantNotices.supersededAt)));
    const open = await db.select({ id: exportHolds.id, tenantId: exportHolds.tenantId, createdAt: exportHolds.createdAt, reason: exportHolds.reason })
      .from(exportHolds).where(isNull(exportHolds.releasedAt)).orderBy(asc(exportHolds.createdAt));
    const age = (d: Date) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY_MS));
    const holdsPart = open.length > 0 ? `${open.length} (oldest ${age(open[0].createdAt)} days)` : '0';
    const line = `Exports in the last 7 days: ${recent.delivered} delivered, ${Number(recent.downloads ?? 0)} downloads, ${pending.n} not yet emailed. Open legal holds: ${holdsPart}`;
    const holds = now.getUTCDate() === 1
      ? open.map((h) => ({ holdId: h.id, tenantId: h.tenantId, ageDays: age(h.createdAt), reason: h.reason }))
      : [];
    return { line, holds };
  });
}
