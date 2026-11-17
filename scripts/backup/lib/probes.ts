/**
 * Permission probes (feature-plan-database-backups.md §6.13, invariants 2 and 3). Each task, at the end of its run, tries
 * the actions its role must NOT have and records what AWS said. Probes never read or change real data.
 *
 * What counts as `denied`:
 *  - HeadObject: HTTP 403 ($metadata.httpStatusCode). A HEAD response has no body, so the SDK reports `Forbidden`, never
 *    `AccessDenied`. The key is known to exist, so 403 can only mean "not allowed".
 *  - S3 PUT / DELETE: the error code `AccessDenied`.
 *  - KMS: `AccessDeniedException`.
 * Any success is `ALLOWED`; any other error is `error:<code or status>`. Either makes `ok = false`.
 */
import type { BackupStore } from './store';
import { PROBE_MISSING_KEY, probeKey } from './keys';

export type ProbeResult = 'denied' | 'skipped' | 'ALLOWED' | `error:${string}`;

export interface KeyProbeClient {
  /** kms:Decrypt of an encrypted data key with its context. */
  decrypt(ciphertextBlob: Buffer, context: Record<string, string>): Promise<void>;
  /** kms:ReEncrypt of the same blob (to the same key). */
  reEncrypt(ciphertextBlob: Buffer, context: Record<string, string>): Promise<void>;
}

interface AwsErr { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }

function code(err: unknown): string {
  const e = (err ?? {}) as AwsErr;
  return String(e.name ?? e.Code ?? e.$metadata?.httpStatusCode ?? 'unknown');
}

export function classifyHead(err: unknown): ProbeResult {
  const status = ((err ?? {}) as AwsErr).$metadata?.httpStatusCode;
  return status === 403 ? 'denied' : `error:${status ?? code(err)}`;
}
export function classifyS3(err: unknown): ProbeResult {
  return code(err) === 'AccessDenied' ? 'denied' : `error:${code(err)}`;
}
export function classifyKms(err: unknown): ProbeResult {
  return code(err) === 'AccessDeniedException' ? 'denied' : `error:${code(err)}`;
}

export async function probe(fn: () => Promise<unknown>, classify: (e: unknown) => ProbeResult): Promise<ProbeResult> {
  try {
    await fn();
    return 'ALLOWED';
  } catch (e) {
    return classify(e);
  }
}

export function probesOk(results: Record<string, unknown>): boolean {
  return Object.entries(results).filter(([k]) => !k.startsWith('edk')).every(([, v]) => v === 'denied' || v === 'skipped');
}

export interface StoredEdk {
  /** base64 of the encrypted data key from a backup object's header. */
  edk: string;
  context: Record<string, string>;
}

/** Backup role: HeadObject its own key, DeleteObject, kms:Decrypt / ReEncrypt of this run's data key, an unconditional PUT. */
export async function backupProbes(store: BackupStore, key: KeyProbeClient, o: { runId: string; writtenKey: string | null; edk: StoredEdk | null }): Promise<Record<string, unknown>> {
  const blob = o.edk ? Buffer.from(o.edk.edk, 'base64') : null;
  const out: Record<string, unknown> = {
    head_own_object: o.writtenKey ? await probe(() => store.head(o.writtenKey!), classifyHead) : 'skipped',
    delete_object: await probe(() => store.delete(PROBE_MISSING_KEY), classifyS3),
    kms_decrypt: blob ? await probe(() => key.decrypt(blob, o.edk!.context), classifyKms) : 'skipped',
    kms_reencrypt: blob ? await probe(() => key.reEncrypt(blob, o.edk!.context), classifyKms) : 'skipped',
    put_without_if_none_match: await probe(() => store.putUnconditional(probeKey(o.runId), Buffer.from('probe')), classifyS3),
  };
  if (o.edk) {
    out.edk = o.edk.edk;
    out.edk_context = o.edk.context;
  }
  return out;
}

/** Audit role: HeadObject the newest listed key (G7), kms:Decrypt of the newest stored data key, DeleteObject. */
export async function auditProbes(store: BackupStore, key: KeyProbeClient, o: { newestKey: string | null; storedEdk: StoredEdk | null }): Promise<Record<string, ProbeResult>> {
  return {
    head_newest_object: o.newestKey ? await probe(() => store.head(o.newestKey!), classifyHead) : 'skipped',
    kms_decrypt: o.storedEdk ? await probe(() => key.decrypt(Buffer.from(o.storedEdk!.edk, 'base64'), o.storedEdk!.context), classifyKms) : 'skipped',
    delete_object: await probe(() => store.delete(PROBE_MISSING_KEY), classifyS3),
  };
}

/** Restore-test role: DeleteObject, and a conditional PUT (it has no s3:PutObject). */
export async function restoreTestProbes(store: BackupStore, o: { runId: string }): Promise<Record<string, ProbeResult>> {
  return {
    delete_object: await probe(() => store.delete(PROBE_MISSING_KEY), classifyS3),
    put_object: await probe(() => store.putSmall(probeKey(o.runId), Buffer.from('probe')), classifyS3),
  };
}
