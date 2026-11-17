/** Small async helpers shared by the backup commands. */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  settled: () => boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (v) => { if (!done) { done = true; res(v); } };
    reject = (e) => { if (!done) { done = true; rej(e); } };
  });
  return { promise, resolve, reject, settled: () => done };
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

/** Reject with `onTimeout()` after `ms`, unless `p` settles first. The timer never keeps the process alive. */
export async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => unknown): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run `fn` over `items` with at most `limit` in flight, in order of the list. */
export async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker));
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Midnight UTC of `d`'s UTC date. */
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The latest Monday 00:00 UTC at or before `d`. */
export function latestMondayUtc(d: Date): Date {
  const day = utcDayStart(d);
  const back = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - back * DAY);
}
