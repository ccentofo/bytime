/**
 * The dump pipeline and its end gate (feature-plan-database-backups.md §6.4 "Encryption", v4.1 §6.2 step 3, U4).
 *
 *   pg_dump.stdout → encryptStream → hashing (SHA-256, bytes; piped with { end: false }) → upload
 *
 * The hashing stream (the upload body) is ended ONLY after pg_dump closes with (0, null) AND the encrypt stream has
 * emitted `end` without error. Any failure first: kill pg_dump, destroy the encrypt stream, `hashing.destroy(err)` (the
 * upload rejects before completing) and `upload.abort()`. So `ok` means every stage succeeded (invariant 6).
 *
 * The SDK's encrypt stream is never `destroy()`ed: it joins its internal streams with a readable-stream `pipeline` that
 * has no callback (@aws-crypto/encrypt-node 5.0.2 encrypt_stream.js), so an early destroy rethrows "Premature close" as an
 * UNCAUGHT exception. On failure it is unpiped and drained instead; killing pg_dump ends its input, so it finishes on its
 * own and nothing downstream reads it.
 */
import { createHash } from 'node:crypto';
import { Transform, type Duplex } from 'node:stream';
import type { BackupStore } from './store';
import { startChild, type SpawnFn } from './child';
import type { HeaderInfo } from './crypto';
import { StageError } from './summarize-error';
import { deferred } from './util';

export const MIN_OBJECT_BYTES = 1024;

export interface DumpPipelineInput {
  spawn: SpawnFn;
  bin: string;
  args: string[];
  env: Record<string, string>;
  makeEncrypt: () => Duplex;
  store: BackupStore;
  key: string;
  /** Aborting fails the pipeline with `signal.reason` (a stage name such as `deadline`) as its stage. */
  signal: AbortSignal;
  onHeader?: (h: HeaderInfo) => void;
}

export interface DumpResult {
  sha256: string;
  bytes: number;
}

export async function runDumpPipeline(input: DumpPipelineInput): Promise<DumpResult> {
  if (input.signal.aborted) throw new StageError(String(input.signal.reason ?? 'aborted'));
  const result = deferred<DumpResult>();
  const hash = createHash('sha256');
  let bytes = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  let encrypt: Duplex;
  try {
    encrypt = input.makeEncrypt();
  } catch (e) {
    throw new StageError('encrypt', e);
  }
  const dump = startChild(input.spawn, input.bin, input.args, input.env, 'ignore');
  const upload = input.store.putStream(input.key, hashing);

  let dumpOk = false;
  let encryptEnded = false;
  let failure: StageError | null = null;

  const fail = (stage: string, err?: unknown, stderr?: string) => {
    if (failure || result.settled()) return;
    failure = err instanceof StageError ? err : new StageError(stage, err, stderr);
    dump.kill();
    encrypt.unpipe(hashing);
    encrypt.resume(); // drain to nowhere; see the header comment on why it is never destroyed
    hashing.destroy(failure);
    void upload.abort().catch(() => {});
    result.reject(failure);
  };
  const maybeEnd = () => {
    if (dumpOk && encryptEnded && !failure) hashing.end();
  };

  const onAbort = () => fail(String(input.signal.reason ?? 'aborted'));
  input.signal.addEventListener('abort', onAbort, { once: true });

  encrypt.once('MessageHeader', (h: HeaderInfo) => input.onHeader?.(h));
  encrypt.on('error', (e) => fail('encrypt', e));
  encrypt.once('end', () => { encryptEnded = true; maybeEnd(); });
  encrypt.pipe(hashing, { end: false });
  hashing.on('error', () => {});
  if (dump.child.stdout) {
    dump.child.stdout.on('error', (err) => fail('dump', err, dump.stderr()));
    dump.child.stdout.pipe(encrypt);
  } else {
    fail('dump');
  }

  void dump.closed.then(({ code, signal, spawnError }) => {
    if (spawnError || code !== 0 || signal) fail('dump', { exitCode: code, signal, message: spawnError?.message }, dump.stderr());
    else { dumpOk = true; maybeEnd(); }
  });
  upload.done.then(() => {
    if (failure) return;
    if (!dumpOk || !encryptEnded) { fail('upload'); return; }
    if (bytes < MIN_OBJECT_BYTES) { fail('too-small'); return; }
    result.resolve({ sha256: hash.digest('hex'), bytes });
  }, (e) => fail(failure ? failure.stage : 'upload', e));

  try {
    return await result.promise;
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }
}
