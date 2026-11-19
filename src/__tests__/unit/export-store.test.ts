import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

/**
 * feature-plan-cloud-export.md §6.3 step 3, audit round 1 (G4): the exports bucket's writes always send If-None-Match: *
 * with 8 MiB parts and never leave parts behind on an error; HEAD 404 is "gone", other errors propagate.
 */
const h = vi.hoisted(() => ({ uploads: [] as Array<Record<string, unknown>>, sent: [] as Array<{ name: string; input: Record<string, unknown> }>, headError: null as unknown }));
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(opts: Record<string, unknown>) { h.uploads.push(opts); }
    done() { return Promise.resolve({}); }
    abort() { return Promise.resolve(); }
  },
}));

import { s3ExportStore, EXPORT_PART_SIZE } from '../../../scripts/backup/lib/export-store';

const client = {
  send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    h.sent.push({ name: cmd.constructor.name, input: cmd.input });
    if (cmd.constructor.name === 'HeadObjectCommand' && h.headError) throw h.headError;
    return {};
  },
} as unknown as import('@aws-sdk/client-s3').S3Client;

describe('G4: s3ExportStore', () => {
  it('putStream: If-None-Match: *, 8 MiB parts, leavePartsOnError false, the exports bucket and key', async () => {
    const store = s3ExportStore(client, 'cadenzpoint-exports-1');
    const body = Readable.from([Buffer.from('zip')]);
    await store.putStream('delivery/d1/a.zip', body).done;
    expect(h.uploads).toHaveLength(1);
    const u = h.uploads[0];
    expect(u.params).toMatchObject({ Bucket: 'cadenzpoint-exports-1', Key: 'delivery/d1/a.zip', Body: body, IfNoneMatch: '*' });
    expect(u.partSize).toBe(EXPORT_PART_SIZE);
    expect(EXPORT_PART_SIZE).toBe(8 * 1024 * 1024);
    expect(u.leavePartsOnError).toBe(false);
  });

  it('exists: true on success, false on a 404, any other error thrown; delete sends DeleteObject', async () => {
    const store = s3ExportStore(client, 'b');
    expect(await store.exists('k')).toBe(true);
    h.headError = Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    expect(await store.exists('k')).toBe(false);
    h.headError = Object.assign(new Error('Forbidden'), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });
    await expect(store.exists('k')).rejects.toThrow('Forbidden');
    await store.delete('hold/h1/a.zip');
    expect(h.sent.at(-1)).toEqual({ name: 'DeleteObjectCommand', input: { Bucket: 'b', Key: 'hold/h1/a.zip' } });
  });
});
