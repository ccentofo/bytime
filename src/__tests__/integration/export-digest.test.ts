import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);

import { controlDb } from '@/db/control-plane';
import { exportDeliveries, exportHolds, opsAlerts, tenantNotices } from '@/db/control-plane/schema';
import { encrypt } from '@/lib/encryption';
import { checkExportCopies, exportDigest, EXPORT_COPY_OVERDUE } from '@/lib/tenant/export-status';
import { sendOpsDigest } from '@/lib/tenant/ops-digest';
import { BACKUP_ALERT_PREFIXES, FINDING_KINDS, syncBackupAlerts } from '@/lib/tenant/backup-status';
import { resendState } from './fakes/fake-resend';
import { cpReady, cleanupLifecycleTenants, makeTenant, type TenantRow } from './lifecycle-helpers';

/**
 * feature-plan-cloud-export.md §11 T12 (§6.7): `export-copy-overdue` (the LEAST query at 6 hours; resolved when none;
 * not touched by 3b's syncBackupAlerts), the digest's daily export line (K excludes superseded and sent) and open-hold
 * count, and the full open-hold list on UTC day 1. Counts are compared against a baseline taken first (the shared test
 * control plane may hold other suites' rows).
 */

const H = 3600_000;
const DAY = 24 * H;

async function addDelivery(t: TenantRow, o: { createdAt: Date; expiresAt: Date; revokedAt?: Date | null; erasedAt?: Date | null; downloads?: number; notice?: 'pending' | 'sent' | 'superseded' }) {
  const [n] = await controlDb.insert(tenantNotices).values({
    tenantId: t.id, kind: 'export-ready', scheduledFor: new Date(o.createdAt.getTime() + Math.floor(Math.random() * 1000)),
    ...(o.notice === 'sent' ? { sentAt: o.createdAt, providerMessageId: 'msg_x' } : {}),
    ...(o.notice === 'superseded' ? { supersededAt: o.createdAt } : {}),
  }).returning();
  const [d] = await controlDb.insert(exportDeliveries).values({
    id: randomUUID(), tenantId: t.id, noticeId: n.id, s3Key: `delivery/${randomUUID()}/x.zip`, bytes: 10, sha256: 'a'.repeat(64),
    tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), recipientsEncrypted: encrypt('[]'), timeZone: 'UTC',
    extraRecipient: false, extraOnly: false, createdAt: o.createdAt, expiresAt: o.expiresAt, revokedAt: o.revokedAt ?? null,
    erasedAt: o.erasedAt ?? null, downloadCount: o.downloads ?? 0, runId: 'test-digest',
  }).returning();
  return d;
}
const parse = (line: string) => {
  const m = /^Exports in the last 7 days: (\d+) delivered, (\d+) downloads, (\d+) not yet emailed\. Open legal holds: (\d+)(?: \(oldest (\d+) days\))?$/.exec(line);
  if (!m) throw new Error(`unexpected line: ${line}`);
  return { delivered: +m[1], downloads: +m[2], pending: +m[3], holds: +m[4], oldest: m[5] === undefined ? null : +m[5] };
};
const openOverdue = () => controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.kind, EXPORT_COPY_OVERDUE), isNull(opsAlerts.resolvedAt)));

describe.skipIf(!cpReady)('T12: export findings and the digest line', () => {
  let t: TenantRow;
  const now = new Date();

  beforeEach(async () => {
    resendState.reset();
    await cleanupLifecycleTenants();
    await controlDb.update(opsAlerts).set({ resolvedAt: now }).where(and(eq(opsAlerts.kind, EXPORT_COPY_OVERDUE), isNull(opsAlerts.resolvedAt)));
    t = await makeTenant({});
  });
  afterEach(async () => {
    await controlDb.update(opsAlerts).set({ resolvedAt: new Date() }).where(and(eq(opsAlerts.kind, EXPORT_COPY_OVERDUE), isNull(opsAlerts.resolvedAt)));
    await cleanupLifecycleTenants();
  });

  it('export-copy-overdue: raised at the first check more than 6 hours after a link stopped working (expiry or revoke); resolved when none remain', async () => {
    // Expired 5 hours ago, revoked 5 hours ago: not yet overdue.
    await addDelivery(t, { createdAt: new Date(now.getTime() - 7 * DAY), expiresAt: new Date(now.getTime() - 5 * H) });
    await addDelivery(t, { createdAt: new Date(now.getTime() - DAY), expiresAt: new Date(now.getTime() + 6 * DAY), revokedAt: new Date(now.getTime() - 5 * H) });
    // An erased one long ago never counts.
    await addDelivery(t, { createdAt: new Date(now.getTime() - 30 * DAY), expiresAt: new Date(now.getTime() - 23 * DAY), erasedAt: new Date(now.getTime() - 23 * DAY) });
    expect((await checkExportCopies(now)).overdue).toBe(0);
    expect(await openOverdue()).toEqual([]);
    // Revoked 7 hours ago while its expiry is days away: LEAST(revoked, expires) → overdue.
    const revoked = await addDelivery(t, { createdAt: new Date(now.getTime() - DAY), expiresAt: new Date(now.getTime() + 6 * DAY), revokedAt: new Date(now.getTime() - 7 * H) });
    expect((await checkExportCopies(now)).overdue).toBe(1);
    const [a] = await openOverdue();
    expect(a).toMatchObject({ scope: 'global', tenantId: null, detail: { count: 1, oldestDeliveryId: revoked.id } });
    // 3b's sync never resolves it (its prefixes are backup- and restore-test-).
    expect(FINDING_KINDS as readonly string[]).not.toContain(EXPORT_COPY_OVERDUE);
    expect(BACKUP_ALERT_PREFIXES.some((p) => EXPORT_COPY_OVERDUE.startsWith(p))).toBe(false);
    await syncBackupAlerts(now).catch(() => {});
    expect((await openOverdue()).length).toBe(1);
    // The sweep erases it: resolved at the next check.
    await controlDb.update(exportDeliveries).set({ erasedAt: now }).where(eq(exportDeliveries.id, revoked.id));
    expect((await checkExportCopies(now)).overdue).toBe(0);
    expect(await openOverdue()).toEqual([]);
  });

  it('expired 7 hours ago and never erased → overdue', async () => {
    await addDelivery(t, { createdAt: new Date(now.getTime() - 7 * DAY - 7 * H), expiresAt: new Date(now.getTime() - 7 * H) });
    expect((await checkExportCopies(now)).overdue).toBe(1);
  });

  it('the daily line: N delivered and M downloads in the last 7 days, K not yet emailed (excluding sent and superseded), open holds with the oldest age', async () => {
    const base = parse((await exportDigest(now)).line);
    await addDelivery(t, { createdAt: new Date(now.getTime() - DAY), expiresAt: new Date(now.getTime() + 6 * DAY), downloads: 3, notice: 'pending' });
    await addDelivery(t, { createdAt: new Date(now.getTime() - 2 * DAY), expiresAt: new Date(now.getTime() + 5 * DAY), downloads: 1, notice: 'sent' });
    await addDelivery(t, { createdAt: new Date(now.getTime() - 3 * DAY), expiresAt: new Date(now.getTime() + 4 * DAY), notice: 'superseded' });
    await addDelivery(t, { createdAt: new Date(now.getTime() - 9 * DAY), expiresAt: new Date(now.getTime() - 2 * DAY), downloads: 50, notice: 'pending' }); // outside the 7 days
    await controlDb.insert(exportHolds).values([
      { id: randomUUID(), tenantId: t.id, s3Key: 'hold/a/x.zip', bytes: 1, sha256: 'b'.repeat(64), reason: 'litigation <A&B>', runId: 'test', createdAt: new Date(now.getTime() - 400 * DAY) },
      { id: randomUUID(), tenantId: t.id, s3Key: 'hold/b/x.zip', bytes: 1, sha256: 'b'.repeat(64), reason: 'released one', runId: 'test', createdAt: new Date(now.getTime() - 500 * DAY), releasedAt: now },
    ]);
    const after = parse((await exportDigest(now)).line);
    expect(after.delivered - base.delivered).toBe(3);
    expect(after.downloads - base.downloads).toBe(4);
    expect(after.pending - base.pending).toBe(1);
    expect(after.holds - base.holds).toBe(1);
    expect(after.oldest).toBe(400); // the released 500-day hold doesn't count
  });

  it('the full open-hold list only on UTC day 1; the digest email carries the line every day and the list on day 1', async () => {
    const hold = { id: randomUUID(), tenantId: t.id, s3Key: 'hold/c/x.zip', bytes: 1, sha256: 'b'.repeat(64), reason: 'subpoena <24-117>', runId: 'test', createdAt: new Date(Date.UTC(2026, 10, 1, 9)) };
    await controlDb.insert(exportHolds).values(hold);
    const day1 = new Date(Date.UTC(2026, 11, 1, 14));
    const day2 = new Date(Date.UTC(2026, 11, 2, 14));
    const first = await exportDigest(day1);
    expect(first.holds).toContainEqual({ holdId: hold.id, tenantId: t.id, ageDays: 30, reason: 'subpoena <24-117>' });
    expect((await exportDigest(day2)).holds).toEqual([]);

    const prev = process.env.OPS_ALERT_EMAIL;
    process.env.OPS_ALERT_EMAIL = 'ops@test.dev';
    try {
      expect(await sendOpsDigest([], day1, false)).toBe('sent');
      const html = resendState.calls.find((c) => c.subject.startsWith('CadenzPoint ops digest'))!.html;
      expect(html).toContain('<h3>Exports</h3>');
      expect(html).toMatch(/Exports in the last 7 days: \d+ delivered/);
      expect(html).toContain(`hold ${hold.id} — workspace ${t.id}, 30 days old: subpoena &lt;24-117&gt;`);
      resendState.reset();
      expect(await sendOpsDigest([], day2, false)).toBe('sent');
      const html2 = resendState.calls.find((c) => c.subject.startsWith('CadenzPoint ops digest'))!.html;
      expect(html2).toContain('<h3>Exports</h3>');
      expect(html2).not.toContain(`hold ${hold.id}`);
    } finally {
      process.env.OPS_ALERT_EMAIL = prev;
    }
  });
});
