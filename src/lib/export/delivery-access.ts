import 'server-only';
import { createHash } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { withLockedPool } from '@/db/control-plane/locked';
import { exportDeliveries, tenants } from '@/db/control-plane/schema';
import { consume } from '@/lib/rate-limit/store';
import { ipIdentifier } from '@/lib/rate-limit/identifier';
import { raiseAlertWithEmail } from '@/lib/tenant/ops-alert-email';
import { resolveAlert } from '@/lib/tenant/lifecycle-store';
import { presignDeliveryUrl } from './download-url';

/**
 * The download page's rules (feature-plan-cloud-export.md §6.6, invariant 3). A link works only for its delivery, until
 * its `expires_at`, only while it isn't revoked or erased, and only while it isn't unavailable under a policy hold: a
 * delivery with `extra_only` false is unavailable while its tenant has `suspension_reason = 'policy'` and
 * `policy_export_allowed` false, whatever its status (the tombstone keeps both, so a deletion doesn't release it; A1).
 * Every unavailable state, and an unknown token, shows the same text (no oracle). A GET never mints a URL.
 */

/** 32 random bytes in base64url: exactly 43 characters. Anything else is "expired" without a database read. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const DOWNLOAD_MISCONFIGURED = 'export-download-misconfigured';

export interface ValidDelivery {
  deliveryId: string;
  tenantName: string;
  bytes: number;
  expiresAt: Date;
  timeZone: string;
  filename: string;
  s3Key: string;
}

export type DeliveryState = { state: 'valid'; delivery: ValidDelivery } | { state: 'unavailable' };

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Look a token up and decide its state (GET and POST both use this). */
export async function readDeliveryByToken(token: string, now: Date = new Date()): Promise<DeliveryState> {
  if (!TOKEN_RE.test(token)) return { state: 'unavailable' };
  const [row] = await controlDb.select({
    id: exportDeliveries.id, s3Key: exportDeliveries.s3Key, bytes: exportDeliveries.bytes, expiresAt: exportDeliveries.expiresAt,
    revokedAt: exportDeliveries.revokedAt, erasedAt: exportDeliveries.erasedAt, extraOnly: exportDeliveries.extraOnly,
    timeZone: exportDeliveries.timeZone, tenantName: tenants.name, suspensionReason: tenants.suspensionReason,
    policyExportAllowed: tenants.policyExportAllowed,
  }).from(exportDeliveries).innerJoin(tenants, eq(tenants.id, exportDeliveries.tenantId))
    .where(eq(exportDeliveries.tokenHash, tokenHash(token))).limit(1);
  if (!row || row.revokedAt || row.erasedAt || row.expiresAt.getTime() <= now.getTime()) return { state: 'unavailable' };
  if (!row.extraOnly && row.suspensionReason === 'policy' && !row.policyExportAllowed) return { state: 'unavailable' };
  return {
    state: 'valid',
    delivery: {
      deliveryId: row.id, tenantName: row.tenantName, bytes: row.bytes, expiresAt: row.expiresAt, timeZone: row.timeZone,
      filename: row.s3Key.split('/').pop() ?? 'export.zip', s3Key: row.s3Key,
    },
  };
}

export type PrepareResult =
  | { status: 'ready'; url: string }
  | { status: 'unavailable' }
  | { status: 'rate-limited' }
  | { status: 'misconfigured' };

/**
 * The POST: the IP limit FIRST (before any token lookup), then the token's state, then the per-delivery limit, then a
 * 5-minute presigned URL; on success the download is counted and the misconfiguration alert resolved. Either env value
 * missing, or an assume-role or presign error (only ever after a valid token) raises `export-download-misconfigured`
 * with an immediate email (a customer is waiting; global, deduplicated).
 */
export async function prepareDownload(token: string, ip: string, now: Date = new Date()): Promise<PrepareResult> {
  if (!(await consume('exportDownloadIp', ipIdentifier(ip))).allowed) return { status: 'rate-limited' };
  const state = await readDeliveryByToken(token, now);
  if (state.state !== 'valid') return { status: 'unavailable' };
  const d = state.delivery;
  if (!(await consume('exportDownload', `delivery:${d.deliveryId}`)).allowed) return { status: 'rate-limited' };
  const signed = await presignDeliveryUrl(d.s3Key, d.filename);
  if (!signed.ok) {
    await raiseAlertWithEmail({
      tenantId: null, kind: DOWNLOAD_MISCONFIGURED,
      summary: signed.reason === 'misconfigured'
        ? 'A customer tried to download a workspace export, but EXPORT_DOWNLOAD_ROLE_ARN or EXPORT_BUCKET is not set on Vercel (PRODUCTION-DEPLOY 13d).'
        : 'A customer tried to download a workspace export, but the presigned URL could not be made (the Vercel OIDC role or the exports bucket).',
      detail: { reason: signed.reason, ...(signed.errorName ? { errorName: signed.errorName } : {}), deliveryId: d.deliveryId },
    }, now);
    return { status: 'misconfigured' };
  }
  await controlDb.update(exportDeliveries)
    .set({ downloadCount: sql`${exportDeliveries.downloadCount} + 1`, lastDownloadAt: now })
    .where(eq(exportDeliveries.id, d.deliveryId));
  try {
    await withLockedPool((db) => resolveAlert(db, { tenantId: null, kind: DOWNLOAD_MISCONFIGURED }, now));
  } catch (err) {
    console.error('[export download] could not resolve the misconfiguration alert:', err instanceof Error ? err.name : 'unknown');
  }
  return { status: 'ready', url: signed.url };
}
