import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { encrypt } from '@/lib/encryption';
import { createScratchDb, dropScratchDb } from './backup-helpers';
import { FakeExportBucket, insertTenant } from './export-harness';
import { runSweep, ORPHAN_HOLD_ALERT } from '../../../scripts/backup/export-sweep';

/**
 * feature-plan-cloud-export.md §11 T11 (the hourly sweep, its own family under the export task role) and T17 (sweep logs):
 * row-driven erasure, delivery and hold orphans, the lookup-error stop. A scratch control plane; a fake exports bucket.
 */

const hasCp = Boolean(process.env.CONTROL_PLANE_DATABASE_URL);
const d = hasCp ? describe : describe.skip;
const DAY = 24 * 3600_000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const db = await createScratchDb('cp', { migrateControlPlane: true });
  const cp = postgres(db.url, { max: 2, onnotice: () => {} });
  cleanups.push(async () => { await cp.end({ timeout: 5 }); await dropScratchDb(db.name); });
  const t = await insertTenant(cp, { dbUrl: 'postgresql://u:p@localhost:5432/none' });
  const bucket = new FakeExportBucket();
  const lines: string[] = [];
  const now = Date.now();
  /** A delivery row (and, unless `noObject`, its object) expiring at `expiresInMs` from now. */
  const delivery = async (o: { expiresInMs: number; revoked?: boolean; erased?: boolean; noObject?: boolean }) => {
    const id = randomUUID();
    const key = `delivery/${id}/${t.slug}-export-20261118.zip`;
    const [n] = await cp<{ id: string }[]>`INSERT INTO tenant_notices (tenant_id, kind, scheduled_for) VALUES (${t.id}, 'export-ready', date_trunc('milliseconds', now()) + make_interval(secs => ${Math.random()})) RETURNING id::text AS id`;
    await cp`INSERT INTO export_deliveries (id, tenant_id, notice_id, s3_key, bytes, sha256, token_hash, token_encrypted, recipients_encrypted, time_zone,
        extra_recipient, extra_only, expires_at, revoked_at, erased_at, run_id, created_at)
      VALUES (${id}, ${t.id}, ${n.id}, ${key}, 10, ${'a'.repeat(64)}, ${randomUUID().replace(/-/g, '').padEnd(64, '0')}, null, ${encrypt('[]')}, 'UTC',
        false, false, ${new Date(now + o.expiresInMs)}, ${o.revoked ? new Date(now - 60_000) : null}, ${o.erased ? new Date(now - 60_000) : null}, 'test-sweep',
        ${new Date(now + o.expiresInMs - 7 * DAY)})`;
    if (!o.noObject) bucket.put(key, Buffer.from('zip'), new Date(now + o.expiresInMs - 7 * DAY));
    return { id, key };
  };
  const hold = async (o: { ageMs: number; withRow: boolean }) => {
    const id = randomUUID();
    const key = `hold/${id}/${t.slug}-export-20261101.zip`;
    if (o.withRow) await cp`INSERT INTO export_holds (id, tenant_id, s3_key, bytes, sha256, reason, run_id) VALUES (${id}, ${t.id}, ${key}, 3, ${'b'.repeat(64)}, 'litigation', 'test-sweep')`;
    bucket.put(key, Buffer.from('zip'), new Date(now - o.ageMs));
    return { id, key };
  };
  const erasedAt = async (id: string) => (await cp<{ e: Date | null }[]>`SELECT erased_at AS e FROM export_deliveries WHERE id = ${id}`)[0].e;
  const openAlerts = () => cp<{ dedupKey: string; scope: string; detail: Record<string, unknown> }[]>`SELECT dedup_key AS "dedupKey", scope, detail FROM ops_alerts WHERE kind = ${ORPHAN_HOLD_ALERT} AND resolved_at IS NULL`;
  const sweep = (over: Partial<Parameters<typeof runSweep>[0]> = {}) => runSweep({ controlPlaneUrl: db.url, store: bucket, log: (l) => lines.push(l), ...over });
  return { cp, db, t, bucket, lines, delivery, hold, erasedAt, openAlerts, sweep };
}

d('T11: the sweep', () => {
  it('row-driven: expired and revoked copies deleted and erased; a missing object still sets erased_at; live copies and erased rows untouched', async () => {
    const s = await setup();
    const expired = await s.delivery({ expiresInMs: -60_000 });
    const revoked = await s.delivery({ expiresInMs: 3 * DAY, revoked: true });
    const gone = await s.delivery({ expiresInMs: -2 * DAY, noObject: true }); // S3's lifecycle got there first
    const live = await s.delivery({ expiresInMs: 3 * DAY });
    const done = await s.delivery({ expiresInMs: -3 * DAY, erased: true, noObject: true });
    const r = await s.sweep();
    expect(r).toMatchObject({ exitCode: 0, erased: 3, errors: 0 });
    for (const x of [expired, revoked, gone]) expect(await s.erasedAt(x.id)).toBeInstanceOf(Date);
    expect(s.bucket.objects.has(expired.key)).toBe(false);
    expect(s.bucket.objects.has(revoked.key)).toBe(false);
    expect(s.bucket.objects.has(live.key)).toBe(true);
    expect(await s.erasedAt(live.id)).toBeNull();
    expect(s.bucket.deleted).not.toContain(done.key);
    expect(s.bucket.deleted).not.toContain(live.key);
  });

  it('delivery orphans older than 1 day are deleted; a row-less delivery/ object under 1 day old is kept', async () => {
    const s = await setup();
    const old = `delivery/${randomUUID()}/${s.t.slug}-export-20261110.zip`;
    const young = `delivery/${randomUUID()}/${s.t.slug}-export-20261118.zip`;
    s.bucket.put(old, Buffer.from('x'), new Date(Date.now() - 2 * DAY));
    s.bucket.put(young, Buffer.from('x'), new Date(Date.now() - 3600_000));
    const r = await s.sweep();
    expect(r.orphansDeleted).toBe(1);
    expect(s.bucket.objects.has(old)).toBe(false);
    expect(s.bucket.objects.has(young)).toBe(true);
  });

  it('hold orphans raise export-orphan-hold and are never deleted; holds with rows are untouched; the alert resolves once the key has a row (or is gone)', async () => {
    const s = await setup();
    const kept = await s.hold({ ageMs: 30 * DAY, withRow: true });
    const orphan = await s.hold({ ageMs: 2 * DAY, withRow: false });
    const fresh = await s.hold({ ageMs: 3600_000, withRow: false }); // under a day: an in-flight record
    const r = await s.sweep();
    expect(r.orphanHolds).toBe(1);
    expect(r.exitCode).toBe(0);
    for (const k of [kept.key, orphan.key, fresh.key]) expect(s.bucket.objects.has(k)).toBe(true);
    expect(s.bucket.deleted.filter((k) => k.startsWith('hold/'))).toEqual([]);
    const [a] = await s.openAlerts();
    expect(a).toMatchObject({ dedupKey: orphan.key, scope: 'global', detail: expect.objectContaining({ holdId: orphan.id }) });
    // Raised again next hour: still one open alert (deduplicated).
    await s.sweep();
    expect((await s.openAlerts()).length).toBe(1);
    // The lead's runbook inserts the row: the next sweep resolves the alert.
    await s.cp`INSERT INTO export_holds (id, tenant_id, s3_key, bytes, sha256, reason, run_id) VALUES (${orphan.id}, ${s.t.id}, ${orphan.key}, 3, ${'b'.repeat(64)}, 'restored by the lead', 'test-sweep')`;
    await s.sweep();
    expect(await s.openAlerts()).toEqual([]);
  });

  it('an orphan alert also resolves when its object is gone', async () => {
    const s = await setup();
    const orphan = await s.hold({ ageMs: 2 * DAY, withRow: false });
    await s.sweep();
    expect((await s.openAlerts()).length).toBe(1);
    s.bucket.objects.delete(orphan.key);
    await s.sweep();
    expect(await s.openAlerts()).toEqual([]);
  });

  it('a control-plane lookup error stops before any orphan step (an error is never "no row")', async () => {
    const s = await setup();
    const old = `delivery/${randomUUID()}/${s.t.slug}-export-20261110.zip`;
    s.bucket.put(old, Buffer.from('x'), new Date(Date.now() - 2 * DAY));
    await s.hold({ ageMs: 2 * DAY, withRow: false });
    await s.cp`ALTER TABLE export_holds RENAME TO export_holds_hidden`;
    try {
      const listSpy: string[] = [];
      const list = s.bucket.list.bind(s.bucket);
      s.bucket.list = async (p: string) => { listSpy.push(p); return list(p); };
      const r = await s.sweep();
      expect(r.exitCode).toBe(1);
      expect(listSpy).toEqual([]);
      expect(s.bucket.objects.has(old)).toBe(true);
      expect(await s.openAlerts()).toEqual([]);
      expect(s.lines.some((l) => l.startsWith('sweep stopped: control-plane read failed'))).toBe(true);
    } finally {
      await s.cp`ALTER TABLE export_holds_hidden RENAME TO export_holds`;
    }
  });

  it('an unreachable control plane stops at once with exit 1, touching nothing', async () => {
    const s = await setup();
    const exp = await s.delivery({ expiresInMs: -60_000 });
    const r = await s.sweep({ controlPlaneUrl: 'postgresql://bytime:wrong@127.0.0.1:1/none' });
    expect(r.exitCode).toBe(1);
    expect(s.bucket.objects.has(exp.key)).toBe(true);
  }, 60_000);

  it('a failed S3 delete is retried next hour (the row stays un-erased); exit 1', async () => {
    const s = await setup();
    const exp = await s.delivery({ expiresInMs: -60_000 });
    s.bucket.failDeletes = 1;
    expect((await s.sweep()).exitCode).toBe(1);
    expect(await s.erasedAt(exp.id)).toBeNull();
    expect((await s.sweep()).exitCode).toBe(0);
    expect(await s.erasedAt(exp.id)).toBeInstanceOf(Date);
  });

  it('T17: the sweep logs ids and counts only, never S3 keys (they contain the slug)', async () => {
    const s = await setup();
    await s.delivery({ expiresInMs: -60_000 });
    await s.hold({ ageMs: 2 * DAY, withRow: false });
    s.bucket.put(`delivery/${randomUUID()}/${s.t.slug}-export-20261110.zip`, Buffer.from('x'), new Date(Date.now() - 2 * DAY));
    await s.sweep();
    const all = s.lines.join('\n');
    expect(all).not.toContain(s.t.slug);
    expect(all).not.toMatch(/delivery\/|hold\/|\.zip/);
    expect(s.lines.at(-1)).toMatch(/^export sweep finished: 1 erased, 1 delivery orphan\(s\) deleted, 1 hold orphan\(s\) reported, 0 error\(s\)$/);
  });
});
