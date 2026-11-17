/**
 * Backup object storage seams (feature-plan-database-backups.md §11): `BackupStore` (write side, plus the probe calls)
 * and `BackupReader` (list and get). Production uses S3 through lib-storage; tests use an in-memory fake with the same
 * error shapes as the SDK (HEAD 403 = { name: 'Forbidden', $metadata: { httpStatusCode: 403 } }; denials `AccessDenied`).
 *
 * Writes always send `If-None-Match: *` (the bucket policy denies a PUT without it, §4.3.8). lib-storage passes it to both
 * PutObject and CompleteMultipartUpload and sends a single PUT only at the body's end (lib-storage 3.1170.0
 * dist-cjs/index.js:257-277, 349-352, 452-464), so a body destroyed with an error never completes an object.
 */
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export interface UploadHandle {
  done: Promise<void>;
  abort: () => Promise<void>;
}

export interface BackupStore {
  /** Stream an object with If-None-Match: *. `done` rejects if the body is destroyed or the write fails. */
  putStream(key: string, body: Readable): UploadHandle;
  /** A small object with If-None-Match: *. */
  putSmall(key: string, bytes: Buffer): Promise<void>;
  /** Probes only (§6.13). */
  head(key: string): Promise<void>;
  delete(key: string): Promise<void>;
  putUnconditional(key: string, bytes: Buffer): Promise<void>;
}

export interface ListedObject {
  key: string;
  lastModified: Date;
  size: number;
}

export interface BackupReader {
  /** Every object under `prefix` (all pages). */
  list(prefix: string): Promise<ListedObject[]>;
  get(key: string): Promise<Readable>;
}

export const PART_SIZE = 64 * 1024 * 1024;
export const QUEUE_SIZE = 2;

export function s3Store(client: S3Client, bucket: string): BackupStore {
  return {
    putStream(key, body) {
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256' },
        partSize: PART_SIZE,
        queueSize: QUEUE_SIZE,
        leavePartsOnError: false,
      });
      return { done: upload.done().then(() => undefined), abort: () => upload.abort() };
    },
    async putSmall(key, bytes) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256' }));
    },
    async head(key) {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async putUnconditional(key, bytes) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }));
    },
  };
}

export function s3Reader(client: S3Client, bucket: string): BackupReader {
  return {
    async list(prefix) {
      const out: ListedObject[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents ?? []) {
          if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: o.LastModified, size: Number(o.Size ?? 0) });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body as Readable;
    },
  };
}
