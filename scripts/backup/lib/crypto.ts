/**
 * Encryption (feature-plan-database-backups.md §6.5), with the AWS Encryption SDK for JavaScript 5.x.
 *
 * - Committing, UNSIGNED suite ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY; commitment policy
 *   REQUIRE_ENCRYPT_REQUIRE_DECRYPT; maxEncryptedDataKeys 1; 64 KiB frames.
 * - Decryption streams through `decryptUnsignedMessageStream`, which refuses signed messages, so no plaintext is ever
 *   released before a signature check (§4.3.3).
 * - Production keyrings are STRICT KMS keyrings naming the key ARN (never an alias: the SDK only attempts data keys whose
 *   providerInfo is a listed full key ARN, @aws-crypto/kms-keyring kms_keyring.js:103-109). Tests use the SDK's raw AES
 *   keyring, so the real streaming code runs without AWS (§11).
 * - The encryption context is authenticated and sent to KMS. The SDK has no "required context" option on decrypt, so
 *   `contextMatches` is ours, run synchronously on the decrypt stream's `MessageHeader` event, which fires after the
 *   header is authenticated and before any body byte is released (parse_header_stream.js).
 */
import type { Duplex } from 'node:stream';
import {
  AlgorithmSuiteIdentifier,
  buildClient,
  CommitmentPolicy,
  KmsKeyringNode,
  RawAesKeyringNode,
  RawAesWrappingSuiteIdentifier,
  type KeyringNode,
} from '@aws-crypto/client-node';
import type { BackupTarget } from './keys';
import { FatalError } from './env';

export const BACKUP_SUITE = AlgorithmSuiteIdentifier.ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY;
export const FRAME_LENGTH = 64 * 1024;
export const CONTEXT_PURPOSE = 'cadenzpoint-backup';

const client = buildClient({ commitmentPolicy: CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT, maxEncryptedDataKeys: 1 });

export interface KeyringFactory {
  encrypt(): KeyringNode;
  decrypt(): KeyringNode;
}

/** Production: encrypt with the generator key; decrypt with a strict keyring naming the current and any retained keys. */
export function kmsKeyringFactory(keyArn: string, decryptKeyArns: string[] = [keyArn]): KeyringFactory {
  if (!/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\//.test(keyArn)) throw new FatalError('BACKUP_KMS_KEY_ARN must be a key ARN (arn:aws:kms:…:key/…), not an alias');
  for (const a of decryptKeyArns) {
    if (!/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\//.test(a)) throw new FatalError('BACKUP_DECRYPT_KEY_ARNS must list key ARNs, not aliases');
  }
  return {
    encrypt: () => new KmsKeyringNode({ generatorKeyId: keyArn }),
    decrypt: () => new KmsKeyringNode({ keyIds: decryptKeyArns }),
  };
}

/** Tests only: the SDK's raw AES keyring with a fixed 32-byte key. */
export function rawAesKeyringFactory(key: Uint8Array, keyName = 'test-key'): KeyringFactory {
  const make = () => new RawAesKeyringNode({
    keyNamespace: 'cadenzpoint-test',
    keyName,
    unencryptedMasterKey: key,
    wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
  });
  return { encrypt: make, decrypt: make };
}

export type ObjectKind = 'dump' | 'manifest';

export interface EncryptionContext {
  purpose: string;
  cp: string;
  kind: ObjectKind;
  target: BackupTarget;
  id: string;
  key: string;
  [k: string]: string;
}

export function encryptionContext(o: { cp: string; kind: ObjectKind; target: BackupTarget; id: string; key: string }): EncryptionContext {
  return { purpose: CONTEXT_PURPOSE, cp: o.cp, kind: o.kind, target: o.target, id: o.id, key: o.key };
}

/** The parts of the SDK's message header this code reads. */
export interface HeaderInfo {
  encryptionContext: Record<string, string>;
  encryptedDataKeys: ReadonlyArray<{ providerId: string; providerInfo: string; encryptedDataKey: Uint8Array }>;
}

/** Exact key set and values. */
export function contextMatches(actual: Record<string, string>, expected: Record<string, string>): boolean {
  const a = Object.keys(actual).sort();
  const e = Object.keys(expected).sort();
  return a.length === e.length && a.every((k, i) => k === e[i] && actual[k] === expected[k]);
}

/** A streaming encryptor. It emits `MessageHeader` (with the encrypted data key) before any ciphertext. */
export function makeEncryptStream(factory: KeyringFactory, context: EncryptionContext): Duplex {
  return client.encryptStream(factory.encrypt(), {
    suiteId: BACKUP_SUITE,
    encryptionContext: context,
    frameLength: FRAME_LENGTH,
  }) as unknown as Duplex;
}

export async function encryptBuffer(factory: KeyringFactory, context: EncryptionContext, plaintext: Buffer): Promise<{ ciphertext: Buffer; header: HeaderInfo }> {
  const { result, messageHeader } = await client.encrypt(factory.encrypt(), plaintext, {
    suiteId: BACKUP_SUITE,
    encryptionContext: context,
    frameLength: FRAME_LENGTH,
  });
  return { ciphertext: result, header: messageHeader as unknown as HeaderInfo };
}

/**
 * A streaming decryptor that refuses signed messages. Listen for `MessageHeader` before reading.
 * It always carries a no-op `error` listener: the SDK's internal pipeline callback re-emits "Premature close" on the
 * returned stream after a destroy (decrypt_stream.js), which would otherwise be an uncaught exception. Callers add their
 * own listener with `on`, never `once`.
 */
export function makeDecryptStream(factory: KeyringFactory): Duplex {
  const stream = client.decryptUnsignedMessageStream(factory.decrypt()) as unknown as Duplex;
  stream.on('error', () => {});
  return stream;
}

export class ContextMismatchError extends Error {
  constructor() {
    super('encryption context mismatch');
    this.name = 'ContextMismatchError';
  }
}

/** Decrypt a small object (the sidecar) and require its context to match exactly. */
export async function decryptBuffer(factory: KeyringFactory, ciphertext: Buffer, expected: Record<string, string>): Promise<Buffer> {
  const stream = makeDecryptStream(factory);
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    let ok = false;
    stream.once('MessageHeader', (h: HeaderInfo) => {
      if (!contextMatches(h.encryptionContext, expected)) {
        stream.destroy(new ContextMismatchError());
        return;
      }
      ok = true;
    });
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', reject);
    stream.once('end', () => (ok ? resolve(Buffer.concat(chunks)) : reject(new ContextMismatchError())));
    stream.end(ciphertext);
  });
}
