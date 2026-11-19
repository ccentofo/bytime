import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A3-G14: openExportSnapshot connects to the DIRECT host (a Neon `-pooler` host has it stripped:
 * transaction pooling can't hold a snapshot), and its first statement is exactly
 * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, so every table in the export comes from one consistent, read-only
 * snapshot. The postgres driver is mocked; no database is opened.
 */

const h = vi.hoisted(() => ({
  urls: [] as string[],
  unsafe: vi.fn(async (_q: string) => []),
  release: vi.fn(),
  end: vi.fn(async () => {}),
}));
vi.mock('postgres', () => ({
  default: vi.fn((url: string) => {
    h.urls.push(url);
    return {
      reserve: async () => ({ unsafe: h.unsafe, release: h.release }),
      end: h.end,
      options: { parsers: {}, serializers: {} },
    };
  }),
}));

import { openExportSnapshot } from '@/lib/export/workspace-export';

beforeEach(() => { h.urls = []; h.unsafe.mockClear(); h.release.mockClear(); h.end.mockClear(); });

describe('openExportSnapshot (A3-G14)', () => {
  it('a -pooler URL connects to the direct host; the first statement opens a repeatable-read, read-only transaction', async () => {
    const snap = await openExportSnapshot('postgresql://u:p@ep-cool-name-123-pooler.us-east-1.aws.neon.tech/acme?sslmode=require');
    expect(h.urls).toHaveLength(1);
    expect(new URL(h.urls[0]).hostname).toBe('ep-cool-name-123.us-east-1.aws.neon.tech');
    expect(h.unsafe.mock.calls.map((c) => c[0])).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY']);
    await snap.close(true);
    expect(h.unsafe.mock.calls.map((c) => c[0])).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT']);
  });

  it('a direct host is kept as it is', async () => {
    const snap = await openExportSnapshot('postgresql://u:p@localhost:5432/acme');
    expect(new URL(h.urls[0]).hostname).toBe('localhost');
    await snap.close(false);
    expect(h.unsafe.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
