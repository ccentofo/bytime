/**
 * Restore one object into a database (feature-plan-database-backups.md §6.7 step 6.3, §6.5 "The header check", U12).
 *
 *   GetObject → hashing (SHA-256 of the ciphertext) → decryptUnsignedMessageStream → pg_restore
 *
 * pg_restore is spawned ONLY after the decrypt stream's `MessageHeader` event has passed the exact context check, run
 * synchronously in the handler; on a mismatch the stream is destroyed (`FAIL:context`) and pg_restore never starts.
 * Success = decryption ended without error, pg_restore closed (0, null), and the SHA-256 equals the row's.
 */
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import type { BackupReader } from './store';
import { startChild, type RunningChild, type SpawnFn } from './child';
import { contextMatches, makeDecryptStream, type HeaderInfo, type KeyringFactory } from './crypto';
import { StageError } from './summarize-error';
import { deferred } from './util';

export interface RestoreObjectInput {
  reader: BackupReader;
  key: string;
  expectedContext: Record<string, string>;
  expectedSha256: string;
  factory: KeyringFactory;
  spawn: SpawnFn;
  bin: string;
  args: string[];
  env: Record<string, string>;
  signal: AbortSignal;
}

export async function restoreObject(input: RestoreObjectInput): Promise<void> {
  if (input.signal.aborted) throw new StageError(String(input.signal.reason ?? 'aborted'));
  const result = deferred<void>();
  let failure: StageError | null = null;
  let restore: RunningChild | null = null;
  let body: Readable | null = null;
  const decrypt = makeDecryptStream(input.factory);
  const hash = createHash('sha256');
  const hashing = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); cb(null, chunk); } });

  let decryptEnded = false;
  let restoreOk = false;
  let hashDone = false;

  const fail = (stage: string, err?: unknown, stderr?: string) => {
    if (failure || result.settled()) return;
    failure = err instanceof StageError ? err : new StageError(stage, err, stderr);
    restore?.kill();
    body?.destroy();
    hashing.destroy();
    decrypt.destroy();
    result.reject(failure);
  };
  const maybeDone = () => {
    if (failure || !decryptEnded || !restoreOk || !hashDone) return;
    if (hash.digest('hex') !== input.expectedSha256) fail('sha256');
    else result.resolve();
  };
  const onAbort = () => fail(String(input.signal.reason ?? 'aborted'));
  input.signal.addEventListener('abort', onAbort, { once: true });

  decrypt.once('MessageHeader', (h: HeaderInfo) => {
    if (!contextMatches(h.encryptionContext, input.expectedContext)) {
      fail('context');
      return;
    }
    restore = startChild(input.spawn, input.bin, input.args, input.env, 'pipe');
    void restore.closed.then(({ code, signal, spawnError }) => {
      if (spawnError || code !== 0 || signal) fail('pg_restore', { exitCode: code, signal, message: spawnError?.message }, restore?.stderr());
      else { restoreOk = true; maybeDone(); }
    });
    if (restore.child.stdin) decrypt.pipe(restore.child.stdin);
  });
  decrypt.on('error', (e) => fail('decrypt', e));
  decrypt.once('end', () => {
    decryptEnded = true;
    if (!restore) fail('decrypt'); // ended without a header: not a valid message
    else maybeDone();
  });
  hashing.on('error', () => {});
  hashing.once('end', () => { hashDone = true; maybeDone(); });
  hashing.pipe(decrypt);

  try {
    body = await input.reader.get(input.key);
  } catch (e) {
    fail('download', e);
  }
  if (body && !failure) {
    body.on('error', (e: Error) => fail('download', e));
    body.pipe(hashing);
  } else if (body) {
    // A stop or deadline fired while GetObject was pending: never leave the late body's socket open.
    body.on('error', () => {});
    body.destroy();
  }

  try {
    await result.promise;
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }
}
