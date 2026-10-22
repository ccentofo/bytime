/**
 * Shared Resend send budget (feature-plan-launch-blockers.md P1 §5). Resend allows 10 requests/second per TEAM,
 * across all API keys. Each cron sender (daily-reminder, submission-deadline, notice-delivery) is held to at most
 * 2 sends/second, so all three running at 20:00 UTC stay ≤ 6/s and leave headroom for user-triggered sends.
 */
export const CRON_SENDS_PER_SECOND = 2;
export const CRON_SEND_INTERVAL_MS = 1000 / CRON_SENDS_PER_SECOND;

/**
 * One throttle per cron run. Await it immediately before each send: it sleeps just long enough that consecutive
 * sends start at least `intervalMs` apart.
 */
export function createSendThrottle(
  intervalMs: number = CRON_SEND_INTERVAL_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): () => Promise<void> {
  let lastStart = Number.NEGATIVE_INFINITY;
  return async function sendThrottle(): Promise<void> {
    const wait = lastStart + intervalMs - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
  };
}
