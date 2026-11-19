import { describe, it, expect, afterEach } from 'vitest';
import JSZip from 'jszip';
import postgres from 'postgres';
import { decrypt } from '@/lib/encryption';
import { makeWorld, fakeEcs, recordingPublisher, type World } from './export-harness';
import { sha256Hex } from '../../../scripts/backup/export';
import { EXPORT_LOCK_KEY } from '@/lib/tenant/backup-locks';

/**
 * feature-plan-cloud-export.md §11 T2, T3, T4, T19, T26, T29 (the start gate and a mid-build deactivation), T17 (deliver
 * logs) and T30 (the deliver lines): the export task's `deliver` against a scratch control plane and a scratch workspace
 * with the real tenant migrations, a fake exports bucket, fake ECS and a recording SNS. No AWS.
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

interface DeliveryRow {
  id: string; noticeId: string; s3Key: string; bytes: string; sha256: string; tokenHash: string; tokenEncrypted: string | null;
  recipientsEncrypted: string; timeZone: string; extraRecipient: boolean; extraOnly: boolean; reason: string | null;
  createdAt: Date; expiresAt: Date; runId: string;
}
const deliveries = (w: World) => w.cp<DeliveryRow[]>`SELECT id::text AS id, notice_id::text AS "noticeId", s3_key AS "s3Key", bytes::text AS bytes,
  sha256, token_hash AS "tokenHash", token_encrypted AS "tokenEncrypted", recipients_encrypted AS "recipientsEncrypted",
  time_zone AS "timeZone", extra_recipient AS "extraRecipient", extra_only AS "extraOnly", reason, created_at AS "createdAt",
  expires_at AS "expiresAt", run_id AS "runId" FROM export_deliveries WHERE tenant_id = ${w.tenant.id}`;
const recipientsOf = (row: DeliveryRow) => JSON.parse(decrypt(row.recipientsEncrypted)) as string[];
const audits = (w: World) => w.cp<{ kind: string; detail: string; actor: string }[]>`SELECT kind, detail, actor FROM tenant_audit_events WHERE tenant_id = ${w.tenant.id}`;
const notices = (w: World) => w.cp<{ id: string; kind: string; micros: number; pending: boolean }[]>`SELECT id::text AS id, kind,
  (extract(microseconds FROM scheduled_for)::bigint % 1000)::int AS micros,
  (sent_at IS NULL AND forced_at IS NULL AND superseded_at IS NULL) AS pending
  FROM tenant_notices WHERE tenant_id = ${w.tenant.id}`;

/** Invariant 5 / T17: no log line or SNS line carries an email, the slug, a token, an S3 key or the reason. */
function expectIdsOnly(w: World, extra: string[] = []) {
  const all = [...w.lines, ...w.pub.sent].join('\n');
  for (const secret of [w.tenant.slug, 'acme.test', 'Acme.test', 'delivery/', 'hold/', '.zip', ...extra]) expect(all, secret).not.toContain(secret);
}

d('T2: deliver', () => {
  it('the ZIP under delivery/<id>/, its SHA-256; the notice, delivery (notice_id) and audit in one transaction; D10 recipients lowercased and deduplicated; the time zone; the SNS line', async () => {
    const w = await world({ admins: ['Admin.One@Acme.test', 'BILLING@acme.test'], timezone: 'america/chicago' });
    const r = await w.run({ mode: 'deliver', reason: 'customer asked by email' });
    expect(r.exitCode, w.lines.join('\n')).toBe(0);
    const [row] = await deliveries(w);
    expect(row.s3Key).toMatch(new RegExp(`^delivery/${row.id}/${w.tenant.slug}-export-\\d{8}\\.zip$`));
    const obj = w.bucket.objects.get(row.s3Key)!;
    expect(obj).toBeDefined();
    expect(row.sha256).toBe(sha256Hex(obj.bytes));
    expect(Number(row.bytes)).toBe(obj.bytes.length);
    const zip = await JSZip.loadAsync(obj.bytes);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['manifest.json', 'README.md', 'users.csv']));
    // D10: the active admins + the billing email (deduplicated, lowercased); the signup email only without an admin.
    expect(recipientsOf(row).sort()).toEqual(['admin.one@acme.test', 'billing@acme.test']);
    expect(row.timeZone).toBe('America/Chicago'); // canonicalised
    expect(row.extraRecipient).toBe(false);
    expect(row.extraOnly).toBe(false);
    expect(row.reason).toBe('customer asked by email');
    expect(row.tokenHash).toBe(sha256Hex(decrypt(row.tokenEncrypted!)));
    expect(decrypt(row.tokenEncrypted!)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(7 * 24 * 3600_000);
    const [n] = await notices(w);
    expect(n).toMatchObject({ id: row.noticeId, kind: 'export-ready', micros: 0, pending: true });
    const [a] = await audits(w);
    expect(a.kind).toBe('export-delivered');
    expect(JSON.parse(a.detail)).toEqual({ deliveryId: row.id, recipients: 2, extraAddress: false, reasonLength: 'customer asked by email'.length });
    expect(a.actor).toBe(`export:${row.runId}`);
    expect(w.pub.sent).toEqual([`export delivered: workspace ${w.tenant.id}, delivery ${row.id}, 2 recipient(s), expires ${row.expiresAt.toISOString()}`]);
    expect(w.bucket.completed).toEqual([row.s3Key]);
    expectIdsOnly(w, ['customer asked']);
    expect(w.lines.some((l) => l.includes(`(reason: ${'customer asked by email'.length} characters)`))).toBe(true);
  });

  it('the signup email only when there is no active admin; the extra address added, lowercased', async () => {
    const w = await world({ admins: [] , tenant: { billingEmail: null } });
    const r = await w.run({ mode: 'deliver', extra: 'Counsel@Law.example', reason: 'r' });
    expect(r.exitCode, w.lines.join('\n')).toBe(0);
    const [row] = await deliveries(w);
    expect(recipientsOf(row).sort()).toEqual(['counsel@law.example', 'signup@acme.test']);
    expect(row.extraRecipient).toBe(true);
    expect(row.extraOnly).toBe(false);
    expectIdsOnly(w, ['law.example', 'Law.example']);
  });

  it('T19: a schema-skewed workspace (one migration ahead) fails schema-skew before any read, before the recipient count, before any upload', async () => {
    const w = await world({ admins: [], tenant: { billingEmail: null, signupEmail: null } }); // no recipients at all
    await w.ws.sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('ahead', 0)`;
    const r = await w.run({ mode: 'deliver' });
    expect(r.exitCode).toBe(1);
    expect(r.line).toBe(`export refused: deliver, workspace ${w.tenant.id}, schema-skew`);
    expect(w.bucket.started).toEqual([]);
    expect(await deliveries(w)).toEqual([]);
    expect(w.pub.sent).toEqual([r.line]);
    expect(__TENANT_JOURNAL_LENGTH__).toBeGreaterThan(0);
  });

  it('T19: one migration behind is skew too', async () => {
    const w = await world();
    await w.ws.sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`;
    expect((await w.run({ mode: 'deliver' })).line).toMatch(/schema-skew$/);
  });

  it('T26: more than 50 recipients → too-many-recipients before anything is built', async () => {
    const w = await world({ admins: Array.from({ length: 51 }, (_, i) => `admin${i}@acme.test`) });
    const r = await w.run({ mode: 'deliver' });
    expect(r.line).toBe(`export refused: deliver, workspace ${w.tenant.id}, too-many-recipients`);
    expect(w.bucket.started).toEqual([]);
  });

  it('no recipients at all → no-recipients before anything is built', async () => {
    const w = await world({ admins: [], tenant: { billingEmail: null, signupEmail: null } });
    expect((await w.run({ mode: 'deliver' })).line).toMatch(/, no-recipients$/);
    expect(w.bucket.started).toEqual([]);
  });
});

d('T3: the policy-hold rule (A1)', () => {
  const hold = { status: 'suspended', suspensionReason: 'policy', policyExportAllowed: false };

  it('export not re-enabled: refused extra-required without --extra; with it the recipients are exactly the extra address and extra_only is true', async () => {
    const w = await world({ tenant: hold });
    const refused = await w.run({ mode: 'deliver' });
    expect(refused.line).toBe(`export refused: deliver, workspace ${w.tenant.id}, extra-required`);
    expect(w.bucket.started).toEqual([]);
    const ok = await w.run({ mode: 'deliver', extra: 'Verified@Contact.example', reason: 'policy case, verified by phone' });
    expect(ok.exitCode, w.lines.join('\n')).toBe(0);
    const [row] = await deliveries(w);
    expect(recipientsOf(row)).toEqual(['verified@contact.example']);
    expect(row.extraOnly).toBe(true);
    expect(row.extraRecipient).toBe(true);
  });

  it('export re-enabled (set-policy-export on): the normal recipients, extra_only false', async () => {
    const w = await world({ tenant: { ...hold, policyExportAllowed: true } });
    expect((await w.run({ mode: 'deliver' })).exitCode).toBe(0);
    const [row] = await deliveries(w);
    expect(recipientsOf(row).sort()).toEqual(['admin.one@acme.test', 'billing@acme.test']);
    expect(row.extraOnly).toBe(false);
  });

  it('a normal deliver plus an extra address → extra_only false', async () => {
    const w = await world();
    expect((await w.run({ mode: 'deliver', extra: 'x@y.example', reason: 'r' })).exitCode).toBe(0);
    const [row] = await deliveries(w);
    expect(row.extraOnly).toBe(false);
    expect(recipientsOf(row)).toContain('x@y.example');
  });

  it('a policy suspension starting mid-build → changed: nothing recorded, the object deleted at once', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver' }, { hooks: { afterUpload: async () => { await w.cp`UPDATE tenants SET status = 'suspended', suspension_reason = 'policy' WHERE id = ${w.tenant.id}`; } } });
    expect(r.line).toBe(`export refused: deliver, workspace ${w.tenant.id}, changed`);
    expect(w.bucket.completed.length).toBe(1);
    expect(w.bucket.objects.size).toBe(0);
    expect(w.bucket.deleted).toEqual(w.bucket.completed);
    expect(await deliveries(w)).toEqual([]);
    expect(await notices(w)).toEqual([]);
  });

  it('a change between the re-resolve and the record (inside the lock) → changed, rolled back, the object deleted', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver' }, { hooks: { beforeBegin: async () => { await w.cp`UPDATE tenants SET policy_export_allowed = true WHERE id = ${w.tenant.id}`; } } });
    expect(r.line).toMatch(/, changed$/);
    expect(w.bucket.objects.size).toBe(0);
    expect(await deliveries(w)).toEqual([]);
    expect(await notices(w)).toEqual([]);
    expect(await audits(w)).toEqual([]);
  });
});

d('T4: statuses', () => {
  for (const [name, tenant] of [
    ['deleted', { status: 'deleted' }],
    ['deleting', { status: 'deleting' }],
    ['provisioning', { status: 'provisioning' }],
    ['no database URL', { dbUrl: null }],
  ] as const) {
    it(`${name} → not-exportable, nothing built`, async () => {
      const w = await world({ tenant: tenant as never });
      const r = await w.run({ mode: 'deliver' });
      expect(r.line).toBe(`export refused: deliver, workspace ${w.tenant.id}, not-exportable`);
      expect(w.bucket.started).toEqual([]);
    });
  }

  it('an unknown workspace id → not-exportable', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver', workspaceId: '00000000-0000-4000-8000-000000000000' });
    expect(r.line).toBe('export refused: deliver, workspace 00000000-0000-4000-8000-000000000000, not-exportable');
  });
});

d('T29 (the start) and the one-at-a-time rule', () => {
  it('a cloudshell- start with --extra is refused; without it, it runs; another caller is refused', async () => {
    const w = await world();
    const cs = await w.run({ mode: 'deliver', extra: 'a@b.example', reason: 'r' }, { ecs: fakeEcs({ startedBy: 'cloudshell-founder' }) });
    expect(cs.line).toBe(`export refused: deliver, workspace ${w.tenant.id}, extra-needs-button`);
    expect(w.bucket.started).toEqual([]);
    expect((await w.run({ mode: 'deliver' }, { ecs: fakeEcs({ startedBy: 'cloudshell-founder' }) })).exitCode).toBe(0);
    for (const startedBy of ['chronos-schedule', null]) {
      expect((await w.run({ mode: 'deliver' }, { ecs: fakeEcs({ startedBy }) })).line).toMatch(/, not-from-button$/);
    }
  });

  it('an older running export task wins (this one is refused before any read)', async () => {
    const w = await world();
    const older = { taskArn: 'arn:aws:ecs:us-east-1:111122223333:task/cadenzpoint-backup/older', startedBy: 'gh-0-1', createdAt: new Date('2026-11-18T11:59:00Z') };
    const r = await w.run({ mode: 'deliver' }, { ecs: fakeEcs({ running: [older] }) });
    expect(r.line).toMatch(/, another-export-running$/);
    expect(w.bucket.started).toEqual([]);
    const newer = { ...older, createdAt: new Date('2026-11-18T12:01:00Z') };
    expect((await w.run({ mode: 'deliver' }, { ecs: fakeEcs({ running: [newer] }) })).exitCode).toBe(0);
  });

  it('an admin deactivated mid-build is left out (the recipients are re-resolved on a fresh connection after the build)', async () => {
    const w = await world({ admins: ['first@acme.test', 'second@acme.test'] });
    const r = await w.run({ mode: 'deliver' }, { hooks: { afterUpload: async () => { await w.ws.sql`UPDATE users SET is_active = false WHERE email = 'second@acme.test'`; } } });
    expect(r.exitCode).toBe(0);
    const [row] = await deliveries(w);
    expect(recipientsOf(row).sort()).toEqual(['billing@acme.test', 'first@acme.test']);
  });
});

d('T30 (deliver): certain no-commit errors after the upload delete at once and report refused; an SNS failure after commit keeps exit 0', () => {
  it('no recipients left at the re-resolve → refused no-recipients, the object deleted', async () => {
    const w = await world({ tenant: { billingEmail: null, signupEmail: null } });
    const r = await w.run({ mode: 'deliver' }, { hooks: { afterUpload: async () => { await w.ws.sql`UPDATE users SET is_active = false`; } } });
    expect(r.line).toBe(`export refused: deliver, workspace ${w.tenant.id}, no-recipients`);
    expect(w.bucket.completed.length).toBe(1);
    expect(w.bucket.objects.size).toBe(0);
    expect(await deliveries(w)).toEqual([]);
  });

  for (const lock of ['tenant', 'export'] as const) {
    it(`a lock timeout (55P03) on the ${lock} lock → refused lock-timeout, nothing committed, the object deleted (D1)`, async () => {
      const w = await world();
      const holder = postgres(w.controlPlaneUrl, { max: 1, onnotice: () => {} });
      try {
        const reserved = await holder.reserve();
        if (lock === 'tenant') await reserved`SELECT pg_advisory_lock(hashtext(${'tenant:' + w.tenant.id}))`;
        else await reserved`SELECT pg_advisory_lock(${EXPORT_LOCK_KEY})`;
        const r = await w.run({ mode: 'deliver' });
        expect(r.line).toBe(`export refused: deliver, workspace ${w.tenant.id}, lock-timeout`);
        expect(w.bucket.objects.size).toBe(0);
        expect(await deliveries(w)).toEqual([]);
        expect(await notices(w)).toEqual([]);
        reserved.release();
      } finally {
        await holder.end({ timeout: 5 });
      }
    }, 30_000);
  }

  it('an SNS publish failure after the commit is logged and the exit stays 0', async () => {
    const w = await world();
    const failing = recordingPublisher({ fail: true });
    const r = await w.run({ mode: 'deliver' }, { publish: failing.publish });
    expect(r.exitCode).toBe(0);
    expect(r.line).toMatch(/^export delivered: /);
    expect(w.lines.some((l) => l.startsWith('the email could not be sent'))).toBe(true);
    expect((await deliveries(w)).length).toBe(1);
  });

  it('a refusal publishes its line too (every run ends with one SNS line)', async () => {
    const w = await world({ tenant: { status: 'deleted' } });
    const r = await w.run({ mode: 'deliver' });
    expect(w.pub.sent).toEqual([r.line]);
  });
});
