import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-large-report-responses.md §11 T1–T5: streamJoined (§6.1). Output equals the joined string; one chunk per
 * 1,000 items between the head and the tail, never an empty chunk; nothing is read before a reader pulls; cancel stops
 * pulls; a throw errors the stream and is reported to Sentry.
 */

const sentry = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: sentry.capture }));

import { streamJoined, STREAM_BATCH } from '@/lib/http/stream-text';

const tick = () => new Promise<void>((r) => setImmediate(r));
const items = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}, "q" — ✓`);

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}
const decode = (chunks: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks));

/** An items array that counts numeric index reads (and can throw on one index). */
function counted(base: string[], throwAt?: number) {
  const state = { reads: 0 };
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        if (throwAt !== undefined && Number(prop) === throwAt) throw new Error(`boom at ${prop}`);
        state.reads++;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy, state };
}

beforeEach(() => { sentry.capture.mockReset(); });

describe('streamJoined (large-report-responses §6.1)', () => {
  it('exports a batch of 1,000', () => {
    expect(STREAM_BATCH).toBe(1000);
  });

  it('T1: the decoded chunks equal head + items.join(separator) + tail', async () => {
    for (const n of [0, 1, 999, 1000, 1001, 2500]) {
      const list = items(n);
      for (const separator of ['\n', ',']) {
        const out = decode(await readAll(streamJoined({ head: 'HEAD\n', items: list, separator, tail: '\nTAIL\n', batch: 1000 })));
        expect(out, `n=${n} sep=${JSON.stringify(separator)}`).toBe('HEAD\n' + list.join(separator) + '\nTAIL\n');
      }
      expect(decode(await readAll(streamJoined({ head: '', items: list, separator: '\n', tail: 'T' })))).toBe(list.join('\n') + 'T');
      expect(decode(await readAll(streamJoined({ head: 'H', items: list, separator: '\n', tail: '' })))).toBe('H' + list.join('\n'));
      expect(decode(await readAll(streamJoined({ head: '', items: list, separator: ',', tail: '' })))).toBe(list.join(','));
    }
  });

  it('T2: head, one chunk per 1,000 items, tail; no empty chunk; empty everything closes at once', async () => {
    const counts: Record<string, number> = {};
    const check = async (label: string, s: ReadableStream<Uint8Array>) => {
      const chunks = await readAll(s);
      expect(chunks.every((c) => c.byteLength > 0), label).toBe(true);
      counts[label] = chunks.length;
    };
    await check('2500', streamJoined({ head: 'H', items: items(2500), separator: '\n', tail: 'T' }));
    await check('0', streamJoined({ head: 'H', items: [], separator: '\n', tail: 'T' }));
    await check('1 bare', streamJoined({ head: '', items: ['x'], separator: '\n', tail: '' }));
    expect(counts).toEqual({ '2500': 5, '0': 2, '1 bare': 1 });

    const reader = streamJoined({ head: '', items: [], separator: '\n', tail: '' }).getReader();
    const first = await Promise.race([reader.read(), new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1000))]);
    expect(first).toEqual({ done: true, value: undefined });
  });

  it('T3: pull-driven: no item is read before a reader asks, then exactly one batch per read', async () => {
    const { proxy, state } = counted(items(2500));
    const reader = streamJoined({ head: 'H', items: proxy, separator: '\n', tail: 'T' }).getReader();
    await tick();
    expect(state.reads).toBe(0);
    await reader.read(); // the head
    await tick();
    expect(state.reads).toBe(0);
    await reader.read(); // batch 1
    await tick();
    expect(state.reads).toBe(1000);
  });

  it('T4: cancel stops pulls (guard)', async () => {
    const { proxy, state } = counted(items(2500));
    const reader = streamJoined({ head: 'H', items: proxy, separator: '\n', tail: 'T' }).getReader();
    await reader.read();
    await reader.read();
    const before = state.reads;
    await expect(reader.cancel()).resolves.toBeUndefined();
    await tick();
    expect(state.reads).toBe(before);
  });

  it('T5: a throw errors the stream (the read rejects) and is reported to Sentry once', async () => {
    const { proxy } = counted(items(2500), 1000);
    const reader = streamJoined({ head: 'H', items: proxy, separator: '\n', tail: 'T' }).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false }); // the head
    await expect(reader.read()).resolves.toMatchObject({ done: false }); // batch 1: items 0–999
    await expect(reader.read()).rejects.toThrow('boom at 1000'); // batch 2 reads index 1000
    expect(sentry.capture).toHaveBeenCalledTimes(1);
    expect((sentry.capture.mock.calls[0][0] as Error).message).toBe('boom at 1000');
  });
});
