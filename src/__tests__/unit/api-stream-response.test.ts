import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-large-report-responses.md §11 T9: apiStreamResponse sends apiResponse's exact bytes (same timestamp),
 * status and Content-Type, in more than one chunk for a big list. Module mocks as v1-api-auth.test.ts:20-43, plus
 * server-only.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenant/context', () => ({ getTenantState: async () => ({ kind: 'none' }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('@/db', () => ({ getDbForUrl: () => ({}), getDb: async () => ({}) }));

import { apiResponse, apiStreamResponse } from '@/lib/api-auth';

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `id-${i}`,
  employeeName: i % 3 === 0 ? `O"Brien — ${i} 😀` : `Emp ${i}`,
  chargeCode: i % 5 ? `CC-${i}` : null,
  submittedAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 12)),
  hours: i / 4,
  skipped: undefined,
}));

async function bytesAndChunks(res: Response): Promise<{ bytes: Buffer; chunks: number }> {
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(parts), chunks: parts.length };
    parts.push(value);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T15:30:00.123Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('apiStreamResponse (large-report-responses §6.3)', () => {
  it('0, 1 and 2,500 rows: the same bytes as apiResponse, status 200, application/json; parses back', async () => {
    for (const n of [0, 1, 2500]) {
      const rows = rowsOf(n);
      const meta = { total: n, unpricedHours: 1.5 };
      const streamed = apiStreamResponse(rows, meta);
      const buffered = apiResponse(rows, meta);
      expect(streamed.status).toBe(200);
      expect(streamed.headers.get('content-type')).toBe('application/json');
      const a = Buffer.from(await streamed.arrayBuffer());
      const b = Buffer.from(await buffered.arrayBuffer());
      expect(a.equals(b), `n=${n}`).toBe(true);
      const parsed = JSON.parse(a.toString('utf8'));
      expect(parsed.data).toHaveLength(n);
      expect(parsed.meta).toEqual({ timestamp: '2026-11-13T15:30:00.123Z', total: n, unpricedHours: 1.5 });
    }
  });

  it('with no meta, the same bytes as apiResponse', async () => {
    const rows = rowsOf(3);
    expect(Buffer.from(await apiStreamResponse(rows).arrayBuffer()).equals(Buffer.from(await apiResponse(rows).arrayBuffer()))).toBe(true);
  });

  it('2,500 rows arrive in more than one chunk', async () => {
    const { chunks } = await bytesAndChunks(apiStreamResponse(rowsOf(2500), { total: 2500 }));
    expect(chunks).toBeGreaterThan(1);
  });
});
