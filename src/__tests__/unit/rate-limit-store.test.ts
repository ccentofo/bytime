import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ratelimit } from '@upstash/ratelimit';

/**
 * feature-plan-upstash-rate-limiting.md §6.2 store: T2, T3, T5–T11, T24. The Upstash path runs through the factory
 * seam (`__setClientFactoriesForTests`): the fake `Ratelimit` records every identifier and `rate` and answers as each
 * test says. No network (T8 uses the real `Redis` constructor, which throws before any request).
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; id: string; rate?: number }>,
  redisOpts: [] as Array<Record<string, unknown>>,
  ratelimitArgs: [] as Array<{ name: string; limit: number; windowMs: number; options: Record<string, unknown> }>,
  answer: null as null | ((name: string, id: string, rate?: number) => Promise<{ success: boolean; reset: number; reason?: string }>),
  noteOutage: vi.fn(),
  noteConfigMissing: vi.fn(),
}));
vi.mock('@/lib/rate-limit/signals', () => ({ noteOutage: h.noteOutage, noteConfigMissing: h.noteConfigMissing }));

import { consume, refund, __resetForTests, __setClientFactoriesForTests, type Decision } from '@/lib/rate-limit/store';
import { SHARED_LIMITS, type SharedLimit } from '@/lib/rate-limit/limits';
import { ipIdentifier, rateLimitId } from '@/lib/rate-limit/identifier';

const NAMES = Object.keys(SHARED_LIMITS) as SharedLimit[];
const IP = '198.51.100.7';

function useFakes() {
  __setClientFactoriesForTests({
    makeRedis: (opts) => { h.redisOpts.push(opts as unknown as Record<string, unknown>); return {} as never; },
    makeRatelimit: (args) => {
      h.ratelimitArgs.push(args as unknown as (typeof h.ratelimitArgs)[number]);
      return {
        limit: async (id: string, req?: { rate?: number }) => {
          h.calls.push({ name: args.name, id, rate: req?.rate });
          if (h.answer) return h.answer(args.name, id, req?.rate);
          return { success: true, reset: Date.now() + 60_000 };
        },
      };
    },
  });
}

function upstashEnv(over: Record<string, string> = {}) {
  const env = {
    UPSTASH_REDIS_REST_URL: ' https://example-123.upstash.io \n',
    UPSTASH_REDIS_REST_TOKEN: '  tok-abc  ',
    KV_REST_API_URL: '',
    KV_REST_API_TOKEN: '',
    SIGNUP_IP_SALT: 'test-salt',
    VERCEL: '',
    ...over,
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

beforeEach(() => {
  h.calls.length = 0;
  h.redisOpts.length = 0;
  h.ratelimitArgs.length = 0;
  h.answer = null;
  h.noteOutage.mockReset();
  h.noteConfigMissing.mockReset();
  useFakes();
  __resetForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('T2: nothing raw reaches Upstash', () => {
  it('every identifier the fake records, for all four limits and both calls, is a 64-hex hash without the IP', async () => {
    upstashEnv();
    for (const name of NAMES) {
      const d = await consume(name, ipIdentifier(IP));
      expect(d.source).toBe('upstash');
      await refund(name, ipIdentifier(IP), d);
    }
    expect(h.calls).toHaveLength(NAMES.length * 2);
    for (const c of h.calls) {
      expect(c.id).toMatch(/^[0-9a-f]{64}$/);
      expect(c.id).not.toContain(IP);
      expect(c.id).toBe(rateLimitId(ipIdentifier(IP)));
    }
  });
});

describe('T3: construction', () => {
  it('one Ratelimit per name from SHARED_LIMITS, fixed window, 500 ms, no analytics/protection/telemetry; Redis: 1 try, function signal, no pipelining, trimmed values', async () => {
    upstashEnv();
    const fixedWindow = vi.spyOn(Ratelimit, 'fixedWindow');
    await consume('signup', ipIdentifier(IP));
    expect(h.ratelimitArgs.map((a) => a.name).sort()).toEqual([...NAMES].sort());
    for (const a of h.ratelimitArgs) {
      const name = a.name as SharedLimit;
      expect(a.limit).toBe(SHARED_LIMITS[name].limit);
      expect(a.windowMs).toBe(SHARED_LIMITS[name].windowMs);
      expect(a.options).toMatchObject({ prefix: `cp-rl:${name}`, timeout: 500, analytics: false, enableProtection: false, enableTelemetry: false });
      expect(a.options.ephemeralCache).toBeInstanceOf(Map);
      expect(fixedWindow).toHaveBeenCalledWith(SHARED_LIMITS[name].limit, `${SHARED_LIMITS[name].windowMs} ms`);
    }
    expect(h.redisOpts).toHaveLength(1);
    const o = h.redisOpts[0];
    expect(o).toMatchObject({ url: 'https://example-123.upstash.io', token: 'tok-abc', retry: { retries: 0 }, enableAutoPipelining: false, enableTelemetry: false });
    expect(typeof o.signal).toBe('function');
    expect((o.signal as () => AbortSignal)()).toBeInstanceOf(AbortSignal);
  });
});

describe('T5: allowed / blocked', () => {
  it('a success is allowed from upstash; a block is refused with retryAfterMs = reset − now', async () => {
    upstashEnv();
    expect(await consume('signup', ipIdentifier(IP))).toMatchObject({ allowed: true, retryAfterMs: 0, source: 'upstash' });
    const reset = Date.now() + 30_000;
    h.answer = async () => ({ success: false, reset });
    const d = await consume('signup', ipIdentifier(IP));
    expect(d).toMatchObject({ allowed: false, source: 'upstash', resetAt: reset });
    expect(d.retryAfterMs).toBeGreaterThan(29_000);
    expect(d.retryAfterMs).toBeLessThanOrEqual(30_000);
  });
});

describe('T6: a timeout falls back to memory, never "allowed"', () => {
  it('reason "timeout" → source memory; after `limit` more calls memory refuses', async () => {
    upstashEnv();
    h.answer = async () => ({ success: true, reset: 0, reason: 'timeout' });
    const first = await consume('signup', ipIdentifier(IP));
    expect(first.source).toBe('memory');
    for (let i = 1; i < SHARED_LIMITS.signup.limit; i++) expect((await consume('signup', ipIdentifier(IP))).allowed).toBe(true);
    const over = await consume('signup', ipIdentifier(IP));
    expect(over).toMatchObject({ allowed: false, source: 'memory' });
  });
});

describe('T7: a throw → memory and a 30 s circuit', () => {
  it('no throw, noteOutage once; the next 29 s skip Upstash; after 30 s it is called again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    upstashEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    h.answer = async () => {
      if (fail) { fail = false; throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); }
      return { success: true, reset: Date.now() + 60_000 };
    };
    const d = await consume('signInFailure', ipIdentifier(IP));
    expect(d.source).toBe('memory');
    expect(h.noteOutage).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-13T12:00:29Z'));
    expect((await consume('signInFailure', ipIdentifier(IP))).source).toBe('memory');
    expect(h.calls).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-13T12:00:30Z'));
    expect((await consume('signInFailure', ipIdentifier(IP))).source).toBe('upstash');
    expect(h.calls).toHaveLength(2);
    expect(h.noteOutage).toHaveBeenCalledTimes(1);
  });
});

describe('T8: an invalid URL', () => {
  it('a rediss:// URL with a password: memory mode, a config alert naming the URL as invalid, nothing logs the password', async () => {
    __setClientFactoriesForTests(); // the real Redis and Ratelimit constructors
    upstashEnv({ UPSTASH_REDIS_REST_URL: 'rediss://default:secret@x.upstash.io:6379', UPSTASH_REDIS_REST_TOKEN: 'tok' });
    const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const d = await consume('signup', ipIdentifier(IP));
    expect(d.source).toBe('memory');
    expect(h.noteConfigMissing).toHaveBeenCalledWith(['UPSTASH_REDIS_REST_URL (invalid)']);
    for (const spy of spies) for (const args of spy.mock.calls) expect(JSON.stringify(args.map(String))).not.toContain('secret');
  });
});

describe('T9: mode and the config alert', () => {
  it('no env → memory, factories never called, no alert', async () => {
    upstashEnv({ UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });
    expect((await consume('signup', ipIdentifier(IP))).source).toBe('memory');
    expect(h.redisOpts).toHaveLength(0);
    expect(h.ratelimitArgs).toHaveLength(0);
    expect(h.noteConfigMissing).not.toHaveBeenCalled();
  });

  it('the Marketplace names (KV_REST_API_*) plus the salt → upstash, even with a blank UPSTASH_* from .env.example', async () => {
    upstashEnv({ UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', KV_REST_API_URL: 'https://kv-1.upstash.io', KV_REST_API_TOKEN: 'kv-tok' });
    expect((await consume('signup', ipIdentifier(IP))).source).toBe('upstash');
    expect(h.redisOpts[0]).toMatchObject({ url: 'https://kv-1.upstash.io', token: 'kv-tok' });
  });

  it.each([[''], [undefined]])('URL and token but no salt (%j) → memory, factories never called', async (salt) => {
    upstashEnv();
    if (salt === undefined) delete process.env.SIGNUP_IP_SALT; else vi.stubEnv('SIGNUP_IP_SALT', salt);
    expect((await consume('signup', ipIdentifier(IP))).source).toBe('memory');
    expect(h.redisOpts).toHaveLength(0);
  });

  it('VERCEL=1 with something missing → noteConfigMissing once, naming it', async () => {
    upstashEnv({ UPSTASH_REDIS_REST_TOKEN: '', VERCEL: '1' });
    await consume('signup', ipIdentifier(IP));
    await consume('slugLookup', ipIdentifier(IP));
    expect(h.noteConfigMissing).toHaveBeenCalledTimes(1);
    expect(h.noteConfigMissing).toHaveBeenCalledWith(['UPSTASH_REDIS_REST_TOKEN']);
  });

  it('NODE_ENV=production without VERCEL (a local npm run start) → no alert', async () => {
    upstashEnv({ UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', SIGNUP_IP_SALT: '', NODE_ENV: 'production' });
    await consume('signup', ipIdentifier(IP));
    expect(h.noteConfigMissing).not.toHaveBeenCalled();
  });
});

describe('T10: logs carry no key', () => {
  it('an UpstashError whose message holds the key → only the error name is logged', async () => {
    upstashEnv();
    const key = `cp-rl:signup:${rateLimitId(ipIdentifier(IP))}:1`;
    h.answer = async () => { throw Object.assign(new Error(`ERR x, command was: [["evalsha","abc",["${key}"]]]`), { name: 'UpstashError' }); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await consume('signup', ipIdentifier(IP));
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('UpstashError');
    expect(logged).not.toContain('command was');
    expect(logged).not.toContain(rateLimitId(ipIdentifier(IP)));
  });
});

describe('T11: refund', () => {
  const future = (source: Decision['source']): Decision => ({ allowed: true, retryAfterMs: 0, source, resetAt: Date.now() + 60_000 });

  it('an upstash count is refunded with rate −1 and the hash, even while the circuit is open; a fake throw is swallowed', async () => {
    upstashEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.answer = async () => { throw new Error('down'); };
    await consume('signInFailure', ipIdentifier(IP)); // opens the circuit
    h.calls.length = 0;
    await expect(refund('signInFailure', ipIdentifier(IP), future('upstash'))).resolves.toBeUndefined(); // throws inside, swallowed
    expect(h.calls).toEqual([{ name: 'signInFailure', id: rateLimitId(ipIdentifier(IP)), rate: -1 }]);
    expect(h.noteOutage).toHaveBeenCalledTimes(1); // the consume's; the refund failure noted nothing (D2)
  });

  it('a memory count never calls Upstash', async () => {
    upstashEnv();
    await refund('signInFailure', ipIdentifier(IP), future('memory'));
    expect(h.calls).toHaveLength(0);
  });

  it('in memory: consume ×3 + refund ×1 leaves 2 used; refunds never go below 0', async () => {
    const id = ipIdentifier(IP);
    let last: Decision | null = null;
    for (let i = 0; i < 3; i++) last = await consume('signup', id);
    await refund('signup', id, last!);
    for (let i = 0; i < SHARED_LIMITS.signup.limit - 2; i++) expect((await consume('signup', id)).allowed).toBe(true);
    expect((await consume('signup', id)).allowed).toBe(false);

    const other = ipIdentifier('198.51.100.8');
    const one = await consume('signup', other);
    for (let i = 0; i < 3; i++) await refund('signup', other, one);
    for (let i = 0; i < SHARED_LIMITS.signup.limit; i++) expect((await consume('signup', other)).allowed).toBe(true);
    expect((await consume('signup', other)).allowed).toBe(false);
  });
});

describe('FR3: the ephemeral cache is bounded', () => {
  it('a cache past 10,000 entries is cleared before the next limit call', async () => {
    upstashEnv();
    await consume('signInFailure', ipIdentifier(IP)); // builds the limiters
    const cache = h.ratelimitArgs.find((a) => a.name === 'signInFailure')!.options.ephemeralCache as Map<string, number>;
    for (let i = 0; i < 10_001; i++) cache.set(`blocked-${i}`, Date.now() + 60_000);
    let sizeSeenByLimit = -1;
    h.answer = async () => { sizeSeenByLimit = cache.size; return { success: true, reset: Date.now() + 60_000 }; };
    await consume('signInFailure', ipIdentifier(IP));
    expect(sizeSeenByLimit).toBe(0);
  });

  it('at exactly 10,000 entries it is kept', async () => {
    upstashEnv();
    await consume('signInFailure', ipIdentifier(IP));
    const cache = h.ratelimitArgs.find((a) => a.name === 'signInFailure')!.options.ephemeralCache as Map<string, number>;
    for (let i = 0; i < 10_000; i++) cache.set(`blocked-${i}`, Date.now() + 60_000);
    await consume('signInFailure', ipIdentifier(IP));
    expect(cache.size).toBe(10_000);
  });
});

describe('T24: no refund across a window', () => {
  it('memory: at resetAt − 1 s the refund does nothing; inside the window it refunds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const id = ipIdentifier(IP);
    const limit = SHARED_LIMITS.signInFailure.limit;
    let d: Decision | null = null;
    for (let i = 0; i < limit; i++) d = await consume('signInFailure', id);
    expect((await consume('signInFailure', id)).allowed).toBe(false);
    vi.setSystemTime(d!.resetAt - 1_000);
    await refund('signInFailure', id, d!);
    expect((await consume('signInFailure', id)).allowed).toBe(false); // unchanged
    vi.setSystemTime(d!.resetAt - 1_001);
    await refund('signInFailure', id, d!);
    expect((await consume('signInFailure', id)).allowed).toBe(true); // refunded inside the window
  });

  it('upstash: at resetAt − 1 s the fake is not called; inside the window it is', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    upstashEnv();
    const d = await consume('signInFailure', ipIdentifier(IP));
    expect(d.source).toBe('upstash');
    h.calls.length = 0;
    vi.setSystemTime(d.resetAt - 1_000);
    await refund('signInFailure', ipIdentifier(IP), d);
    expect(h.calls).toHaveLength(0);
    vi.setSystemTime(d.resetAt - 1_001);
    await refund('signInFailure', ipIdentifier(IP), d);
    expect(h.calls).toEqual([{ name: 'signInFailure', id: rateLimitId(ipIdentifier(IP)), rate: -1 }]);
  });
});
