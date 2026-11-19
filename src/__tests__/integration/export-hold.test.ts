import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeWorld, type World } from './export-harness';
import { sha256Hex } from '../../../scripts/backup/export';

/**
 * feature-plan-cloud-export.md §11 T6 (`hold` and `release`), T17 (hold logs) and T30 (the hold and release lines).
 */

const hasCp = Boolean(process.env.CONTROL_PLANE_DATABASE_URL);
const d = hasCp ? describe : describe.skip;

let worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds) await w.cleanup();
  worlds = [];
});
async function world(o: Parameters<typeof makeWorld>[0] = {}) {
  const w = await makeWorld(o);
  worlds.push(w);
  return w;
}
const holds = (w: World) => w.cp<{ id: string; s3Key: string; bytes: string; sha256: string; reason: string; runId: string; releasedAt: Date | null; releaseReason: string | null }[]>`
  SELECT id::text AS id, s3_key AS "s3Key", bytes::text AS bytes, sha256, reason, run_id AS "runId", released_at AS "releasedAt", release_reason AS "releaseReason"
  FROM export_holds WHERE tenant_id = ${w.tenant.id}`;
const audits = (w: World) => w.cp<{ kind: string; detail: string }[]>`SELECT kind, detail FROM tenant_audit_events WHERE tenant_id = ${w.tenant.id} ORDER BY created_at`;
const expectIdsOnly = (w: World) => {
  const all = [...w.lines, ...w.pub.sent].join('\n');
  for (const secret of [w.tenant.slug, 'hold/', '.zip', 'acme.test', 'subpoena', 'case closed']) expect(all, secret).not.toContain(secret);
};

d('T6: hold', () => {
  it('the hold row and object under hold/<id>/; the export-held audit carries the hold id; the SNS line carries it; no customer email', async () => {
    const w = await world();
    const r = await w.run({ mode: 'hold', reason: 'subpoena 24-117' });
    expect(r.exitCode, w.lines.join('\n')).toBe(0);
    const [h] = await holds(w);
    expect(h.s3Key).toMatch(new RegExp(`^hold/${h.id}/${w.tenant.slug}-export-\\d{8}\\.zip$`));
    const obj = w.bucket.objects.get(h.s3Key)!;
    expect(h.sha256).toBe(sha256Hex(obj.bytes));
    expect(Number(h.bytes)).toBe(obj.bytes.length);
    expect(h).toMatchObject({ reason: 'subpoena 24-117', releasedAt: null, releaseReason: null });
    const [a] = await audits(w);
    expect(a.kind).toBe('export-held');
    expect(JSON.parse(a.detail)).toEqual({ holdId: h.id, bytes: obj.bytes.length, reasonLength: 'subpoena 24-117'.length });
    expect(r.line).toBe(`export held: workspace ${w.tenant.id}, hold ${h.id}`);
    expect(w.pub.sent).toEqual([r.line]);
    expect((await w.cp`SELECT 1 FROM tenant_notices WHERE tenant_id = ${w.tenant.id}`).length).toBe(0);
    expect((await w.cp`SELECT 1 FROM export_deliveries WHERE tenant_id = ${w.tenant.id}`).length).toBe(0);
    expectIdsOnly(w);
  });

  it('no recipient checks for a hold: a policy-hold workspace without --extra, one with no recipients and one over 50 all pass', async () => {
    const policy = await world({ tenant: { status: 'suspended', suspensionReason: 'policy', policyExportAllowed: false } });
    expect((await policy.run({ mode: 'hold', reason: 'r' })).exitCode, policy.lines.join('\n')).toBe(0);
    const none = await world({ admins: [], tenant: { billingEmail: null, signupEmail: null } });
    expect((await none.run({ mode: 'hold', reason: 'r' })).exitCode).toBe(0);
    const many = await world({ admins: Array.from({ length: 51 }, (_, i) => `a${i}@acme.test`) });
    expect((await many.run({ mode: 'hold', reason: 'r' })).exitCode).toBe(0);
  });

  it('the schema check applies to hold', async () => {
    const w = await world();
    await w.ws.sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('ahead', 0)`;
    const r = await w.run({ mode: 'hold', reason: 'r' });
    expect(r.line).toBe(`export refused: hold, workspace ${w.tenant.id}, schema-skew`);
    expect(w.bucket.started).toEqual([]);
  });

  it('a non-exportable workspace is refused for hold too', async () => {
    const w = await world({ tenant: { status: 'deleting' } });
    expect((await w.run({ mode: 'hold', reason: 'r' })).line).toMatch(/, not-exportable$/);
  });

  it('a hold record error after the transaction started → the object kept, "outcome unknown: hold <id>", exit 1', async () => {
    const w = await world();
    const r = await w.run({ mode: 'hold', reason: 'r' }, { hooks: { afterCommit: async () => { throw new Error('socket hang up'); } } });
    expect(r.exitCode).toBe(1);
    const [h] = await holds(w);
    expect(r.line).toBe(`export outcome unknown: hold, workspace ${w.tenant.id}, hold ${h.id}`);
    expect(w.bucket.objects.has(h.s3Key)).toBe(true);
    expect(w.bucket.deleted).toEqual([]);
  });
});

d('T6: release', () => {
  it('deletes the object, verifies it is gone, then marks the hold released with an audit; a second release is refused', async () => {
    const w = await world();
    await w.run({ mode: 'hold', reason: 'subpoena' });
    const [h] = await holds(w);
    const r = await w.run({ mode: 'release', holdId: h.id, reason: 'case closed' });
    expect(r.exitCode, w.lines.join('\n')).toBe(0);
    expect(r.line).toBe(`export released: hold ${h.id}`);
    expect(w.bucket.objects.has(h.s3Key)).toBe(false);
    expect(w.bucket.deleted).toEqual([h.s3Key]);
    const [after] = await holds(w);
    expect(after.releasedAt).toBeInstanceOf(Date);
    expect(after.releaseReason).toBe('case closed');
    const a = (await audits(w)).find((x) => x.kind === 'export-hold-released')!;
    expect(JSON.parse(a.detail)).toEqual({ holdId: h.id, reasonLength: 'case closed'.length });
    const again = await w.run({ mode: 'release', holdId: h.id, reason: 'again' });
    expect(again.line).toBe(`export refused: release, hold ${h.id}, released`);
    expect(w.bucket.deleted).toEqual([h.s3Key]); // no second delete
    expectIdsOnly(w);
  });

  it('F13: a hold whose object is already gone: the delete is idempotent, the 404 verifies, it is released', async () => {
    const w = await world();
    await w.run({ mode: 'hold', reason: 'r' });
    const [h] = await holds(w);
    w.bucket.objects.delete(h.s3Key);
    const r = await w.run({ mode: 'release', holdId: h.id, reason: 'r' });
    expect(r.exitCode).toBe(0);
    expect((await holds(w))[0].releasedAt).not.toBeNull();
  });

  it('an unknown hold id is refused; a delete error fails without touching the row', async () => {
    const w = await world();
    const unknown = randomUUID();
    expect((await w.run({ mode: 'release', holdId: unknown, reason: 'r' })).line).toBe(`export refused: release, hold ${unknown}, unknown-hold`);
    await w.run({ mode: 'hold', reason: 'r' });
    const [h] = await holds(w);
    w.bucket.failDeletes = 1;
    const r = await w.run({ mode: 'release', holdId: h.id, reason: 'r' });
    expect(r.line).toBe(`export failed: release, hold ${h.id}, s3-error`);
    expect((await holds(w))[0].releasedAt).toBeNull();
    expect(w.bucket.objects.has(h.s3Key)).toBe(true);
  });

  it('a delete S3 accepted but the object still there → failed delete-unverified, not released', async () => {
    const w = await world();
    await w.run({ mode: 'hold', reason: 'r' });
    const [h] = await holds(w);
    const real = w.bucket.delete.bind(w.bucket);
    w.bucket.delete = async (key: string) => { w.bucket.deleted.push(key); }; // "succeeds" but deletes nothing
    const r = await w.run({ mode: 'release', holdId: h.id, reason: 'r' });
    w.bucket.delete = real;
    expect(r.line).toBe(`export failed: release, hold ${h.id}, delete-unverified`);
    expect((await holds(w))[0].releasedAt).toBeNull();
  });
});
