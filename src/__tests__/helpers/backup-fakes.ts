/**
 * In-memory fakes for the backup seams (feature-plan-database-backups.md §11). Error shapes match the AWS SDK:
 * HEAD 403 → { name: 'Forbidden', $metadata: { httpStatusCode: 403 } }; S3 denials `AccessDenied`; KMS denials
 * `AccessDeniedException`.
 */
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type { BackupReader, BackupStore, ListedObject } from '../../../scripts/backup/lib/store';
import { rawAesKeyringFactory } from '../../../scripts/backup/lib/crypto';

export const TEST_AES_KEY = Buffer.alloc(32, 7);
export const testKeyring = () => rawAesKeyringFactory(TEST_AES_KEY);

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
