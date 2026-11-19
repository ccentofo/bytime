/**
 * The export task's test world (feature-plan-cloud-export.md §11; impact analysis §6.1, D7): a scratch control plane
 * (`bkt_cp_*`, migrated) or the app's control plane, a scratch workspace database (`bkt_t_*`) with the REAL tenant
 * migrations, and fakes for S3 (the exports bucket), ECS (self and running) and SNS. No AWS.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { encrypt } from '@/lib/encryption';
import { createScratchDb, dropScratchDb } from './backup-helpers';
import type { ExportStore } from '../../../scripts/backup/lib/export-store';
import type { ListedObject } from '../../../scripts/backup/lib/store';
import type { DisasterEcs, EcsTaskInfo } from '../../../scripts/backup/lib/aws-clients';
import { runExport, type ExportArgs, type ExportDeps, type ExportResult } from '../../../scripts/backup/export';

export const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
export const s3Error = () => Object.assign(new Error('We encountered an internal error'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } });
export const preconditionFailed = () => Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });

/** The exports bucket: objects, the multipart lifecycle (started/completed/aborted), If-None-Match, deletes, 404s. */
export class FakeExportBucket implements ExportStore {
  objects = new Map<string, { bytes: Buffer; lastModified: Date }>();
  started: string[] = [];
  completed: string[] = [];
  aborted: string[] = [];
  deleted: string[] = [];
  now: () => Date = () => new Date();
  /** Fail the upload with an S3 error after this many bytes (the body is still drained). */
  failUploadAfterBytes: number | null = null;
  /** Make the next deletes fail. */
  failDeletes = 0;
  /** Make list() fail for these prefixes. */
  failList = new Set<string>();

  putStream(key: string, body: Readable) {
    this.started.push(key);
    const chunks: Buffer[] = [];
    let size = 0;
    let settle: { resolve: () => void; reject: (e: unknown) => void } | null = null;
    let finished = false;
    const done = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    const fail = (e: unknown) => {
      if (finished) return;
      finished = true;
      body.destroy();
      settle!.reject(e);
    };
    body.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      if (this.failUploadAfterBytes !== null && size > this.failUploadAfterBytes) fail(s3Error());
    });
    body.once('end', () => {
      if (finished) return;
      finished = true;
      if (this.objects.has(key)) { settle!.reject(preconditionFailed()); return; } // If-None-Match: *
      this.objects.set(key, { bytes: Buffer.concat(chunks), lastModified: this.now() });
      this.completed.push(key);
      settle!.resolve();
    });
    body.once('error', (e) => fail(e));
    body.once('close', () => { if (!finished && !body.readableEnded) fail(new Error('body closed early')); });
    return {
      done,
      abort: async () => {
        if (!this.aborted.includes(key)) this.aborted.push(key);
        fail(Object.assign(new Error('Upload aborted.'), { name: 'AbortError' }));
      },
    };
  }

  async delete(key: string) {
    if (this.failDeletes > 0) { this.failDeletes--; throw s3Error(); }
    this.deleted.push(key);
    this.objects.delete(key); // idempotent, as S3
  }

  async exists(key: string) {
    return this.objects.has(key);
  }

  async list(prefix: string): Promise<ListedObject[]> {
    if (this.failList.has(prefix)) throw s3Error();
    return [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, lastModified: o.lastModified, size: o.bytes.length }));
  }

  put(key: string, bytes: Buffer, lastModified: Date) {
    this.objects.set(key, { bytes, lastModified });
  }
}

/** ECS as the task sees it: itself (startedBy, createdAt) and its family's running tasks. */
export function fakeEcs(o: { startedBy?: string | null; running?: EcsTaskInfo[]; failSelf?: boolean } = {}): DisasterEcs {
  const self: EcsTaskInfo = { taskArn: 'arn:aws:ecs:us-east-1:111122223333:task/cadenzpoint-backup/self', startedBy: o.startedBy === undefined ? 'gh-1-1' : o.startedBy, createdAt: new Date('2026-11-18T12:00:00Z') };
  return {
    self: async () => { if (o.failSelf) throw new Error('metadata unreachable'); return self; },
    running: async () => [self, ...(o.running ?? [])],
  };
}

export function recordingPublisher(o: { fail?: boolean } = {}) {
  const sent: string[] = [];
  const publish = async (_subject: string, message: string) => {
    if (o.fail) throw Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
    sent.push(message);
  };
  return { sent, publish };
}

export interface Workspace {
  id: string;
  slug: string;
  dbName: string;
  dbUrl: string;
  sql: postgres.Sql;
}

/** A scratch workspace database with the real tenant migrations, an admin, an employee and a time zone. */
export async function createWorkspaceDb(o: { admins?: string[]; timezone?: string } = {}): Promise<{ name: string; url: string; sql: postgres.Sql }> {
  const db = await createScratchDb('t');
  const sql = postgres(db.url, { max: 2, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  for (const email of o.admins ?? ['Admin.One@Acme.test']) {
    await sql`INSERT INTO users (email, full_name, role) VALUES (${email}, 'Admin', 'admin')`;
  }
  await sql`INSERT INTO users (email, full_name, role) VALUES ('employee@acme.test', 'Employee', 'employee')`;
  await sql`INSERT INTO workspace_settings (id, timezone) VALUES (1, ${o.timezone ?? 'America/Chicago'}) ON CONFLICT (id) DO UPDATE SET timezone = EXCLUDED.timezone`;
  return { ...db, sql };
}

/** A tenant row pointing at a workspace database (status, suspension and emails as given). */
export async function insertTenant(cp: postgres.Sql, o: {
  dbUrl: string | null; slug?: string; status?: string; suspensionReason?: string | null; policyExportAllowed?: boolean;
  billingEmail?: string | null; signupEmail?: string | null;
}): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = o.slug ?? `test-lc-ex${id.slice(0, 8)}`;
  await cp`INSERT INTO tenants (id, slug, name, status, db_url_encrypted, suspension_reason, policy_export_allowed, billing_email, signup_email)
    VALUES (${id}, ${slug}, 'Acme Export Test', ${o.status ?? 'active'}::tenant_status, ${o.dbUrl ? encrypt(o.dbUrl) : null}, ${o.suspensionReason ?? null},
      ${o.policyExportAllowed ?? false}, ${o.billingEmail === undefined ? 'Billing@Acme.test' : o.billingEmail}, ${o.signupEmail === undefined ? 'signup@acme.test' : o.signupEmail})`;
  return { id, slug };
}

/** The world: a scratch control plane (or a given one), a workspace and its tenant row, and the fakes. */
export async function makeWorld(o: { controlPlaneUrl?: string; tenant?: Parameters<typeof insertTenant>[1] extends infer T ? Partial<T> : never; admins?: string[]; timezone?: string } = {}) {
  const cpDb = o.controlPlaneUrl ? null : await createScratchDb('cp', { migrateControlPlane: true });
  const controlPlaneUrl = o.controlPlaneUrl ?? cpDb!.url;
  const cp = postgres(controlPlaneUrl, { max: 2, onnotice: () => {} });
  const ws = await createWorkspaceDb({ admins: o.admins, timezone: o.timezone });
  const t = await insertTenant(cp, { dbUrl: ws.url, ...o.tenant });
  const bucket = new FakeExportBucket();
  const lines: string[] = [];
  const pub = recordingPublisher();
  const deps = (over: Partial<ExportDeps> = {}): ExportDeps => ({
    controlPlaneUrl, store: bucket, ecs: fakeEcs(), publish: pub.publish, log: (l) => lines.push(l), ...over,
  });
  const run = (args: Partial<ExportArgs> & { mode: ExportArgs['mode'] }, over: Partial<ExportDeps> = {}): Promise<ExportResult> =>
    runExport({ workspaceId: t.id, runId: `test-${randomUUID().slice(0, 8)}`, ...args } as ExportArgs, deps(over));
  const cleanup = async () => {
    await cp`DELETE FROM export_deliveries WHERE tenant_id = ${t.id}`.catch(() => {});
    await cp`DELETE FROM export_holds WHERE tenant_id = ${t.id}`.catch(() => {});
    await cp`DELETE FROM tenant_notices WHERE tenant_id = ${t.id}`.catch(() => {});
    await cp`DELETE FROM tenant_audit_events WHERE tenant_id = ${t.id}`.catch(() => {});
    await cp`DELETE FROM tenants WHERE id = ${t.id}`.catch(() => {});
    await cp.end({ timeout: 5 }).catch(() => {});
    await ws.sql.end({ timeout: 5 }).catch(() => {});
    await dropScratchDb(ws.name).catch(() => {});
    if (cpDb) await dropScratchDb(cpDb.name).catch(() => {});
  };
  return { cp, controlPlaneUrl, ws, tenant: t, bucket, lines, pub, deps, run, cleanup };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
