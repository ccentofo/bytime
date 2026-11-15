import { Redis, type RedisConfigNodejs } from '@upstash/redis';
import { Ratelimit, type RatelimitConfig } from '@upstash/ratelimit';
import { SHARED_LIMITS, type SharedLimit } from './limits';
import { rateLimitId } from './identifier';
import { memoryConsume, memoryRefund, memoryReset } from './memory';

/**
 * The shared-limit store (feature-plan-upstash-rate-limiting.md §6.2): named limits counted in one Upstash Redis
 * database, falling back to the in-process limiter when Upstash isn't configured, is slow (500 ms) or fails (Q1).
 *
 * Import rule: many tests load this through `src/lib/rate-limit.ts` without a `server-only` mock, so this module and
 * everything it imports at the top must load in plain Node: no `server-only`, no database client. The alert module
 * (`./signals`, server-only, control plane) is imported lazily, only when an outage or a config problem is noted.
 *
 * Privacy (invariant 1): every identifier is an HMAC (`rateLimitId`) before anything below sees it. Upstash error
 * messages can contain the key or a URL with a password, so only error NAMES are ever logged.
 */

export type Decision = {
  allowed: boolean;
  retryAfterMs: number;
  source: 'upstash' | 'memory';
  /** When the window holding this count ends (ms). */
  resetAt: number;
};

type RatelimitResult = { success: boolean; reset: number; reason?: string };
/** The part of a `Ratelimit` the store uses (the test fakes implement just this). */
export type RatelimitLike = { limit(identifier: string, req?: { rate?: number }): Promise<RatelimitResult> };

type ClientFactories = {
  makeRedis(opts: RedisConfigNodejs): Redis;
  makeRatelimit(args: { name: SharedLimit; limit: number; windowMs: number; options: RatelimitConfig }): RatelimitLike;
};

const realFactories: ClientFactories = {
  makeRedis: (opts) => new Redis(opts),
  makeRatelimit: ({ options }) => new Ratelimit(options),
};
let factories: ClientFactories = realFactories;

const UPSTASH_TIMEOUT_MS = 500;
const CIRCUIT_OPEN_MS = 30_000;
const CACHE_MAX_ENTRIES = 10_000;
/** No refund at or after this long before the counting window ends (§6.2 item 5). */
const REFUND_CUTOFF_MS = 1_000;

const names = Object.keys(SHARED_LIMITS) as SharedLimit[];

/** The ephemeral "blocked until" caches, one per limit, cleared when they grow past CACHE_MAX_ENTRIES. */
const caches = new Map<SharedLimit, Map<string, number>>();
function cacheFor(name: SharedLimit): Map<string, number> {
  let cache = caches.get(name);
  if (!cache) {
    cache = new Map();
    caches.set(name, cache);
  }
  return cache;
}

/** An error's name only — never its message (it can hold a key, or a URL with a password). */
function errName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : 'Error';
}

export type UpstashBuild =
  | { ok: true; limiters: Record<SharedLimit, RatelimitLike> }
  /** `invalid`: every value was set but a client didn't build (alerted anywhere, not only on Vercel). */
  | { ok: false; missing: string[]; invalid: boolean };

/**
 * Build the Upstash clients from an environment, with no caching and no alerts: shared by the store's mode decision
 * and the cron's config check (`resolveRateLimitSignals`), so both judge a configuration the same way. Values are read
 * with `||` (an empty value counts as unset) and trimmed. Without SIGNUP_IP_SALT it never builds: the HMAC secret must
 * be the real salt for anything sent to Upstash.
 */
export function buildUpstash(env: NodeJS.ProcessEnv = process.env): UpstashBuild {
  const url = (env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '').trim();
  const token = (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '').trim();
  const missing: string[] = [];
  if (!url) missing.push('UPSTASH_REDIS_REST_URL');
  if (!token) missing.push('UPSTASH_REDIS_REST_TOKEN');
  if (!env.SIGNUP_IP_SALT) missing.push('SIGNUP_IP_SALT');
  if (missing.length > 0) return { ok: false, missing, invalid: false };

  let redis: Redis;
  try {
    redis = factories.makeRedis({
      url,
      token,
      retry: { retries: 0 }, // one try
      signal: () => AbortSignal.timeout(UPSTASH_TIMEOUT_MS), // the function form: an abort throws
      enableTelemetry: false,
      enableAutoPipelining: false, // each check is its own request and its own failure
    });
  } catch {
    // e.g. UrlError, whose message contains the whole URL — never logged.
    return { ok: false, missing: ['UPSTASH_REDIS_REST_URL (invalid)'], invalid: true };
  }

  try {
    const limiters = {} as Record<SharedLimit, RatelimitLike>;
    for (const name of names) {
      const { limit, windowMs } = SHARED_LIMITS[name];
      limiters[name] = factories.makeRatelimit({
        name,
        limit,
        windowMs,
        options: {
          redis,
          limiter: Ratelimit.fixedWindow(limit, `${windowMs} ms`),
          prefix: `cp-rl:${name}`,
          timeout: UPSTASH_TIMEOUT_MS,
          analytics: false,
          enableProtection: false,
          ephemeralCache: cacheFor(name),
          enableTelemetry: false,
        },
      });
    }
    return { ok: true, limiters };
  } catch (err) {
    console.error('[rate-limit] setup failed:', errName(err));
    return { ok: false, missing: ['rate-limit setup'], invalid: true };
  }
}

type StoreState =
  | { mode: 'upstash'; limiters: Record<SharedLimit, RatelimitLike> }
  | { mode: 'memory' };

let state: StoreState | null = null;
let circuitOpenUntil = 0;

/**
 * Decided on the first call and cached for the life of the process. Returns the names to raise in a config alert when
 * this call decided `memory` and an alert is due: an invalid configuration anywhere, missing values only on a Vercel
 * deployment (local dev, tests and a local `npm run start` raise nothing).
 */
function resolveState(): { s: StoreState; alert: string[] | null } {
  if (state) return { s: state, alert: null };
  const built = buildUpstash();
  if (built.ok) {
    state = { mode: 'upstash', limiters: built.limiters };
    return { s: state, alert: null };
  }
  state = { mode: 'memory' };
  return { s: state, alert: built.invalid || process.env.VERCEL === '1' ? built.missing : null };
}

const memoryKey = (name: SharedLimit, id: string) => `shared:${name}:${id}`;

function fromMemory(name: SharedLimit, id: string): Decision {
  const { limit, windowMs } = SHARED_LIMITS[name];
  const r = memoryConsume(memoryKey(name, id), limit, windowMs);
  return { allowed: r.allowed, retryAfterMs: r.retryAfterMs, source: 'memory', resetAt: r.resetAt };
}

/** Upstash failed or timed out: open the circuit for 30 s and note the outage (never throws). */
async function outage(name: SharedLimit, err: unknown): Promise<void> {
  circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
  console.error('[rate-limit]', name, 'upstash unavailable:', errName(err));
  try {
    (await import('./signals')).noteOutage(err);
  } catch (noteErr) {
    console.error('[rate-limit] could not note the outage:', errName(noteErr));
  }
}

/** Note a missing or invalid configuration (never throws). */
async function configMissing(missing: string[]): Promise<void> {
  try {
    (await import('./signals')).noteConfigMissing(missing);
  } catch (noteErr) {
    console.error('[rate-limit] could not note the missing configuration:', errName(noteErr));
  }
}

/** Count one request against `name` for `identifier` (hashed before use). Never throws, never refuses for an outage. */
export async function consume(name: SharedLimit, identifier: string): Promise<Decision> {
  const id = rateLimitId(identifier);
  const { s, alert } = resolveState();
  if (alert) await configMissing(alert);
  if (s.mode === 'memory') return fromMemory(name, id);
  if (Date.now() < circuitOpenUntil) return fromMemory(name, id);

  let result: RatelimitResult | null = null;
  let failure: unknown = null;
  try {
    const cache = cacheFor(name);
    if (cache.size > CACHE_MAX_ENTRIES) cache.clear();
    result = await s.limiters[name].limit(id);
    if (result.reason === 'timeout') {
      failure = Object.assign(new Error('timeout'), { name: 'RatelimitTimeout' });
      result = null;
    }
  } catch (err) {
    failure = err;
    result = null;
  }
  if (!result) {
    await outage(name, failure);
    return fromMemory(name, id);
  }
  return {
    allowed: result.success,
    retryAfterMs: result.success ? 0 : Math.max(0, result.reset - Date.now()),
    source: 'upstash',
    resetAt: result.reset,
  };
}

/**
 * Take back one count, in the store and the window that counted it (`counted`). Skipped once that window has ended or
 * nearly has, so a refund can never land in a later window and create budget. The circuit isn't consulted and a
 * failure changes nothing but a log line by name. Never throws.
 */
export async function refund(name: SharedLimit, identifier: string, counted: Decision): Promise<void> {
  try {
    if (Date.now() >= counted.resetAt - REFUND_CUTOFF_MS) return;
    const id = rateLimitId(identifier);
    if (counted.source === 'memory') {
      memoryRefund(memoryKey(name, id));
      return;
    }
    const { s } = resolveState();
    if (s.mode !== 'upstash') return; // an upstash count implies upstash mode; defensive only
    const r = await s.limiters[name].limit(id, { rate: -1 });
    if (r.reason === 'timeout') console.error('[rate-limit]', name, 'refund failed:', 'RatelimitTimeout');
  } catch (err) {
    console.error('[rate-limit]', name, 'refund failed:', errName(err));
  }
}

/** Test seam: replace the client constructors (no argument restores the real ones). */
export function __setClientFactoriesForTests(f?: Partial<ClientFactories>): void {
  factories = f ? { ...realFactories, ...f } : realFactories;
}

/** Test seam: forget the mode, the circuit, the ephemeral caches and the memory counters. */
export function __resetForTests(): void {
  state = null;
  circuitOpenUntil = 0;
  caches.clear();
  memoryReset();
}
