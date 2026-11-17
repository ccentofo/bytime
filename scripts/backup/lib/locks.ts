/**
 * Session advisory locks that survive long runs (feature-plan-database-backups.md §6.4 "One run at a time", F22).
 *
 * - Every lock connection uses the control plane's DIRECT host (`toDirectConnectionUrl`): a session lock on Neon's
 *   pooler can be taken and released on different server connections.
 * - Lock connections are never recycled: postgres.js closes a connection after `max_lifetime` (default 30–60 min,
 *   node_modules/postgres/src/index.js:513-515) and the next query silently opens a new session, losing the lock. So every
 *   lock client is `{ max: 1, max_lifetime: null, idle_timeout: null }` (a null lifetime disables the timer,
 *   connection.js:1042-1045), and the lock is held on a `reserve()`d connection for the whole run.
 * - A heartbeat every 60 s checks `pg_locks` for this session's lock, with a 15 s timeout (covers half-open TCP). A missing
 *   row, a closed connection or a timeout is LOCK-LOST.
 * - A reserved handle is never used after its connection closes: postgres.js would throw a TypeError from an unawaited
 *   promise (an unhandled rejection; src/query.js `handle()`, connection.js:156-182). The `closed` flag is set by
 *   `onclose`, which runs in a macrotask, and is checked synchronously right before each query, whose execution happens a
 *   microtask later, so a close can't slip in between. Re-taking a lock always uses a NEW client.
 */
import postgres from 'postgres';
import { toDirectConnectionUrl } from '../../../src/lib/tenant/direct-url';
import { clientUrl } from './pg-url';
import { withTimeout } from './util';

export type Sql = postgres.Sql;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Connect = (url: string, options: postgres.Options<{}>) => Sql;
export const defaultConnect: Connect = (url, options) => postgres(url, options);

/**
 * `idle_timeout: null` is what postgres.js does at runtime (`k in o ? o[k]`, src/index.js:476-480; a falsy value disables
 * the timer). Its type says `number | undefined`, hence the cast; `null` is kept so the intent is explicit (U5).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const LOCK_CLIENT_OPTIONS: postgres.Options<{}> = { max: 1, max_lifetime: null, idle_timeout: null as unknown as undefined, connect_timeout: 30 };

export interface LockTiming {
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
}
export const DEFAULT_LOCK_TIMING: LockTiming = { heartbeatMs: 60_000, heartbeatTimeoutMs: 15_000 };

/** The URL every lock and pg_locks connection uses: direct host, query reduced for postgres.js. */
export function lockUrl(url: string): string {
  return clientUrl(toDirectConnectionUrl(url));
}

/** A non-reserved client for pg_locks reads (it may reconnect; it holds no session state). */
export function probeClient(url: string, connect: Connect = defaultConnect): Sql {
  return connect(lockUrl(url), { ...LOCK_CLIENT_OPTIONS });
}

export interface HeldLock {
  readonly key: number;
  readonly lost: boolean;
  /** Called once, when the lock is found lost (never after release()). */
  onLost(cb: () => void): void;
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** true: block in pg_advisory_lock until granted; false: pg_try_advisory_lock, null when not granted. */
  wait?: boolean;
  timing?: LockTiming;
  connect?: Connect;
  /** Test seam: replaces the pg_locks heartbeat query (e.g. one that hangs). */
  heartbeat?: () => Promise<boolean>;
}

export function splitKey(key: number): { hi: number; lo: number } {
  return { hi: Math.floor(key / 2 ** 32), lo: key % 2 ** 32 };
}

export async function acquireLock(url: string, key: number, opts: AcquireOptions = {}): Promise<HeldLock | null> {
  const timing = opts.timing ?? DEFAULT_LOCK_TIMING;
  const connect = opts.connect ?? defaultConnect;
  let closed = false;
  let lost = false;
  let releasing = false;
  const listeners: Array<() => void> = [];
  const hb: { timer?: NodeJS.Timeout } = {};

  const markLost = () => {
    if (lost || releasing) return;
    lost = true;
    if (hb.timer) clearInterval(hb.timer);
    void sql.end({ timeout: 0 }).catch(() => {});
    for (const cb of listeners.splice(0)) {
      try { cb(); } catch { /* listeners must not break the heartbeat */ }
    }
  };

  const sql = connect(lockUrl(url), { ...LOCK_CLIENT_OPTIONS, onclose: () => { closed = true; markLost(); } });
  let reserved: postgres.ReservedSql;
  try {
    reserved = await sql.reserve();
    if (opts.wait) {
      await reserved`SELECT pg_advisory_lock(${key})`;
    } else {
      const [row] = await reserved<{ got: boolean }[]>`SELECT pg_try_advisory_lock(${key}) AS got`;
      if (!row?.got) {
        releasing = true;
        reserved.release();
        await sql.end({ timeout: 5 }).catch(() => {});
        return null;
      }
    }
  } catch (err) {
    releasing = true;
    await sql.end({ timeout: 1 }).catch(() => {});
    throw err;
  }

  const { hi, lo } = splitKey(key);
  const check = opts.heartbeat ?? (async () => {
    if (closed || lost) return false;
    const rows = await reserved`SELECT 1 AS held FROM pg_locks
      WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND classid = ${hi} AND objid = ${lo} AND objsubid = 1 AND granted`;
    return rows.length > 0;
  });
  let busy = false;
  hb.timer = setInterval(() => {
    if (busy || lost || closed || releasing) return;
    busy = true;
    withTimeout(check(), timing.heartbeatTimeoutMs, () => new Error('heartbeat timeout'))
      .then((ok) => { if (!ok) markLost(); }, () => markLost())
      .finally(() => { busy = false; });
  }, timing.heartbeatMs);
  hb.timer.unref?.();

  return {
    key,
    get lost() { return lost; },
    onLost(cb) { if (lost) cb(); else listeners.push(cb); },
    async release() {
      if (releasing) return;
      // Set first: a close during the unlock query must not fire lock-lost (and start a re-take nobody releases).
      releasing = true;
      if (hb.timer) clearInterval(hb.timer);
      const usable = !lost && !closed;
      if (usable) {
        try {
          await withTimeout(Promise.resolve(reserved`SELECT pg_advisory_unlock(${key})`), 5_000, () => new Error('unlock timeout'));
        } catch { /* the session ends below, which releases the lock anyway */ }
      }
      if (usable && !closed) reserved.release();
      await sql.end({ timeout: 5 }).catch(() => {});
    },
  };
}

/** Re-take a lock after a loss: a new client each try (the first can fail with 57P01 while the old session ends). */
export async function retakeLock(url: string, key: number, opts: AcquireOptions & { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<HeldLock | null> {
  const tries = opts.tries ?? 3;
  for (let i = 0; i < tries; i++) {
    try {
      const l = await acquireLock(url, key, { ...opts, wait: false });
      if (l) return l;
    } catch { /* retried */ }
    if (i < tries - 1) await (opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(opts.delayMs ?? 2_000);
  }
  return null;
}
