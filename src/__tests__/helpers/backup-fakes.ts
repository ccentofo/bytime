/**
 * In-memory fakes for the backup seams (feature-plan-database-backups.md §11). Error shapes match the AWS SDK:
 * HEAD 403 → { name: 'Forbidden', $metadata: { httpStatusCode: 403 } }; S3 denials `AccessDenied`; KMS denials
 * `AccessDeniedException`.
 */
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type { BackupReader, BackupStore, ListedObject } from '../../../scripts/backup/lib/store';
import { encryptBuffer, encryptionContext, rawAesKeyringFactory } from '../../../scripts/backup/lib/crypto';

export const TEST_AES_KEY = Buffer.alloc(32, 7);
export const testKeyring = () => rawAesKeyringFactory(TEST_AES_KEY);

/**
 * The SDK's RAW AES keyring (tests only; production uses the KMS keyring) wraps the very first data key of a process so
 * that it can't be unwrapped ("unencryptedDataKey has not been set" on decrypt); every later message is fine. Found while
 * building S10 (deterministic: 1 of 200, always the first). The KMS keyring path doesn't have it (U12 "the KMS keyring
 * decrypts its first message", with a fake KMS client). So every suite using these fakes burns that first wrap here.
 */
await encryptBuffer(testKeyring(), encryptionContext({ cp: 'prime', kind: 'dump', target: 'tenant', id: 'prime', key: 'prime' }), Buffer.from('prime'));

export const s3Denied = () => Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
export const headForbidden = () => Object.assign(new Error('Forbidden'), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });
export const kmsDenied = () => Object.assign(new Error('not authorized'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } });
export const preconditionFailed = () => Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });

export interface FakeObject {
  bytes: Buffer;
  lastModified: Date;
}

export class FakeBucket implements BackupStore, BackupReader {
  objects = new Map<string, FakeObject>();
  /** Keys whose upload body reached end-of-stream (S2: a failed dump never does). */
  completedStreams: string[] = [];
  abortedStreams: string[] = [];
  /** Keys whose upload body was destroyed or errored. */
  failedStreams: string[] = [];
  now: () => Date = () => new Date();
  /** Reject the next N putStream calls with 412 (S4). */
  reject412 = 0;
  /** Probe behaviour: what each probe call does. */
  probe: { head: () => void; delete: () => void; putUnconditional: () => void; putSmallProbe: () => void } = {
    head: () => { throw headForbidden(); },
    delete: () => { throw s3Denied(); },
    putUnconditional: () => { throw s3Denied(); },
    putSmallProbe: () => { throw s3Denied(); },
  };
  /** Fail reads of keys matching this predicate mid-stream (FAIL:download). */
  failGet: (key: string) => boolean = () => false;
  listCalls: string[] = [];
  /** Observe each putStream start (concurrency tests). */
  onPutStream?: (key: string) => void;

  putStream(key: string, body: Readable) {
    this.onPutStream?.(key);
    const chunks: Buffer[] = [];
    let aborted = false;
    const done = new Promise<void>((resolve, reject) => {
      body.on('data', (c: Buffer) => chunks.push(c));
      body.once('end', () => {
        if (aborted) { reject(new Error('aborted')); return; }
        this.completedStreams.push(key);
        if (this.reject412 > 0) { this.reject412--; reject(preconditionFailed()); return; }
        if (this.objects.has(key)) { reject(preconditionFailed()); return; }
        this.objects.set(key, { bytes: Buffer.concat(chunks), lastModified: this.now() });
        resolve();
      });
      body.once('error', (e) => { this.failedStreams.push(key); reject(e); });
      body.once('close', () => { if (!(body as Readable).readableEnded) { this.failedStreams.push(key); reject(new Error('body closed early')); } });
    });
    return { done, abort: async () => { aborted = true; this.abortedStreams.push(key); } };
  }

  async putSmall(key: string, bytes: Buffer) {
    if (key.startsWith('v1/probe/')) { this.probe.putSmallProbe(); }
    if (this.objects.has(key)) throw preconditionFailed();
    this.objects.set(key, { bytes, lastModified: this.now() });
  }
  async head(key: string) {
    this.probe.head();
    if (!this.objects.has(key)) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  }
  async delete() { this.probe.delete(); }
  async putUnconditional() { this.probe.putUnconditional(); }

  async list(prefix: string): Promise<ListedObject[]> {
    this.listCalls.push(prefix);
    return [...this.objects.entries()].filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, lastModified: o.lastModified, size: o.bytes.length }));
  }
  async get(key: string): Promise<Readable> {
    const o = this.objects.get(key);
    if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    if (this.failGet(key)) {
      const half = o.bytes.subarray(0, Math.floor(o.bytes.length / 2));
      return new Readable({
        read() {
          this.push(half);
          setImmediate(() => this.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
        },
      });
    }
    return Readable.from([o.bytes]);
  }

  /** Age every object (the restore test ignores objects under 30 minutes old). */
  ageAll(ms: number) {
    for (const o of this.objects.values()) o.lastModified = new Date(o.lastModified.getTime() - ms);
  }
}

/** A node one-liner standing in for pg_dump: writes `bytes` random bytes, then exits `code` (optionally hangs). */
export function fakeDumpArgs(o: { bytes?: number; code?: number; hang?: boolean; failAfterBytes?: number; slowMs?: number }): string[] {
  const n = o.bytes ?? 200_000;
  const script = o.slowMs !== undefined
    ? `let i = 0; const t = setInterval(() => { process.stdout.write(Buffer.alloc(8192, i % 251)); if (++i * 50 >= ${o.slowMs}) { clearInterval(t); process.stdout.write(Buffer.alloc(8192, 3), () => process.exit(0)); } }, 50);`
    : o.hang
    ? `process.stdout.write(Buffer.alloc(4096, 1)); setInterval(() => {}, 1000);`
    : o.failAfterBytes !== undefined
      ? `process.stdout.write(Buffer.alloc(${o.failAfterBytes}, 2), () => { process.stderr.write('pg_dump: error: Dumping the contents of table "users" failed\\npg_dump: detail: Command was: COPY public.users (id, email) TO stdout;\\nDETAIL: Key (email)=(secret@x.com)'); process.exit(${o.code ?? 1}); });`
      : `const b = Buffer.from(${JSON.stringify(randomBytes(16).toString('hex'))}.repeat(${Math.ceil(n / 32)})).subarray(0, ${n}); process.stdout.write(b, () => process.exit(${o.code ?? 0}));`;
  return ['-e', script];
}

import type { AuditClients } from '../../../scripts/backup/lib/aws-clients';
import type { KeyProbeClient } from '../../../scripts/backup/lib/probes';
import { expectedDocuments, NAMES, ALL_ROLES } from '../../../scripts/backup/lib/expected-policies';

export const TEST_ACCOUNT = '111122223333';
export const TEST_KEY_ARN = `arn:aws:kms:us-east-1:${TEST_ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`;

/** AuditClients reporting a perfectly protected stack (rendered from expected-policies.ts); tests mutate the state. */
export function fakeAuditClients() {
  const exp = expectedDocuments({ accountId: TEST_ACCOUNT, keyArn: TEST_KEY_ARN });
  const doc = (s: unknown) => JSON.stringify({ Version: '2012-10-17', Statement: s });
  const state = {
    versioning: '',
    uploads: [] as Array<{ key: string; initiated: Date }>,
    bucketPolicy: doc(exp.bucketPolicy) as string | null,
    lifecycle: [{ id: NAMES.lifecycleRule, status: 'Enabled', prefix: 'v1/', expirationDays: 25, abortDays: 1, other: false }] as Array<{ id: string | null; status: string | null; prefix: string | null; expirationDays: number | null; abortDays: number | null; other: boolean }> | null,
    keyState: 'Enabled',
    keyPolicy: doc(exp.keyPolicy) as string | null,
    subscriptions: [{ arn: `${exp.topicArn}:0000-sub`, protocol: 'email' }],
    filterPolicy: null as string | null,
    topicPolicy: doc(exp.topicPolicy) as string | null,
    rules: Object.fromEntries(Object.entries(exp.rulePatterns).map(([n, p]) => [n, { state: 'ENABLED', eventPattern: JSON.stringify(p) as string | null }])) as Record<string, { state: string; eventPattern: string | null } | null>,
    targets: Object.fromEntries(Object.keys(exp.rulePatterns).map((n) => [n, [exp.topicArn]])) as Record<string, string[]>,
    logging: true,
    alarm: { actionsEnabled: true, alarmActions: [exp.topicArn], metricName: 'ApproximateNumberOfMessagesVisible', namespace: 'AWS/SQS', threshold: 0, comparison: 'GreaterThanThreshold', treatMissingData: 'notBreaching', dimensions: { QueueName: NAMES.dlq } } as AuditClientsAlarm | null,
    roles: Object.fromEntries(ALL_ROLES.map((r) => [r, { trust: doc(exp.roles[r].trust) as string | null, policies: { [NAMES.inlinePolicy]: doc(exp.roles[r].policy) } as Record<string, string>, attached: [] as string[] }])),
    throwOn: new Set<string>(),
  };
  const guard = (k: string) => { if (state.throwOn.has(k)) throw Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }); };
  const clients: AuditClients = {
    bucket: {
      versioning: async () => { guard('versioning'); return state.versioning; },
      multipartUploads: async () => { guard('uploads'); return state.uploads; },
      policy: async () => { guard('bucket-policy'); return state.bucketPolicy; },
      lifecycle: async () => { guard('lifecycle'); return state.lifecycle; },
    },
    key: { state: async () => { guard('key-state'); return state.keyState; }, policy: async () => { guard('key-policy'); return state.keyPolicy; } },
    topic: {
      subscriptions: async () => { guard('subscriptions'); return state.subscriptions; },
      filterPolicy: async () => state.filterPolicy,
      policy: async () => state.topicPolicy,
    },
    rules: { describe: async (n) => state.rules[n] ?? null, targets: async (n) => state.targets[n] ?? [] },
    trail: { isLogging: async () => state.logging },
    alarm: { describe: async () => state.alarm },
    iam: {
      trust: async (r) => state.roles[r]?.trust ?? null,
      inlinePolicyNames: async (r) => Object.keys(state.roles[r]?.policies ?? {}),
      inlinePolicy: async (r, n) => state.roles[r]?.policies[n] ?? null,
      attachedPolicies: async (r) => state.roles[r]?.attached ?? [],
    },
  };
  return { clients, state, exp, doc };
}
type AuditClientsAlarm = NonNullable<Awaited<ReturnType<AuditClients['alarm']['describe']>>>;

/** A KMS probe client that refuses everything (the expected state). */
export function deniedKeyClient(): KeyProbeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    decrypt: async () => { calls.push('decrypt'); throw kmsDenied(); },
    reEncrypt: async () => { calls.push('reEncrypt'); throw kmsDenied(); },
  };
}
