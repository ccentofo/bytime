/**
 * The exports bucket (feature-plan-cloud-export.md §6.1, §6.3): `cadenzpoint-exports-<account>`, SSE-KMS with the bucket
 * key (the bucket's default encryption: no header is sent). Only the export task role writes or deletes here; it also runs
 * the hourly sweep. Production uses S3 through lib-storage; tests use an in-memory fake with the SDK's error shapes.
 *
 * Writes send `If-None-Match: *` (lib-storage 3.1170.0 passes it to PutObject and CompleteMultipartUpload) in 8 MiB parts:
 * the ~3.94 GiB zip limit is at most 505 parts (§9). A failed or aborted upload aborts its multipart upload
 * (`leavePartsOnError: false`), and the bucket's `abort-mpu` rule is the backstop.
 */
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { s3Reader, type ListedObject, type UploadHandle } from './store';

export const EXPORT_PART_SIZE = 8 * 1024 * 1024;
export const EXPORT_QUEUE_SIZE = 2;

export interface ExportStore {
  /** Stream an object with If-None-Match: *. `done` rejects if the body errors or the write fails; `abort` stops it. */
  putStream(key: string, body: Readable): UploadHandle;
  /** Delete one object. An already-missing object is not an error (S3's DeleteObject is idempotent). */
  delete(key: string): Promise<void>;
  /** HEAD: true when the object exists, false on 404 (the task role has ListBucket, so a missing key is a 404, not a 403). */
  exists(key: string): Promise<boolean>;
  /** Every object under `prefix` (all pages). */
  list(prefix: string): Promise<ListedObject[]>;
}

function httpStatus(e: unknown): number | undefined {
  return (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

export function s3ExportStore(client: S3Client, bucket: string): ExportStore {
  const reader = s3Reader(client, bucket);
  return {
    putStream(key, body) {
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', ContentType: 'application/zip' },
        partSize: EXPORT_PART_SIZE,
        queueSize: EXPORT_QUEUE_SIZE,
        leavePartsOnError: false,
      });
      return { done: upload.done().then(() => undefined), abort: () => upload.abort() };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (e) {
        if (httpStatus(e) === 404 || (e as { name?: string })?.name === 'NotFound') return false;
        throw e;
      }
    },
    list: (prefix) => reader.list(prefix),
  };
}
