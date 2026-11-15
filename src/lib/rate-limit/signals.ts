import 'server-only';
import { after } from 'next/server';
import { withLockedPool } from '@/db/control-plane/locked';
import { resolveAlert } from '@/lib/tenant/lifecycle-store';
import { raiseAlertWithEmail } from '@/lib/tenant/ops-alert-email';
import { lastSignalAt, recordWindowedSignal } from '@/lib/signup/signals';
import { buildUpstash } from './store';

/**
 * Rate-limit ops alerts (feature-plan-upstash-rate-limiting.md §6.6): an Upstash outage and missing or invalid
 * configuration, resolved by the notice-delivery cron like the Turnstile alerts. Loaded lazily by the store, so its
 * control-plane imports never reach the plain-Node tests that load the store.
 *
 * No per-signal Sentry event (a long outage would use up the quota): the one Sentry message comes from
 * raiseAlertWithEmail when the alert opens. Errors are logged by name only.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
export const RATE_LIMIT_OUTAGE_THRESHOLD = 3;
const OUTAGE_KIND = 'rate-limit-outage';
const CONFIG_KIND = 'rate-limit-config-missing';

let lastOutageNoteAt = 0;
let lastConfigNoteAt = 0;

function errName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : 'Error';
}

/** Run `work` after the response (falls back to an unawaited promise outside a request scope). Never rejects. */
function schedule(label: string, work: () => Promise<void>): void {
  const safe = async () => {
    try {
      await work();
    } catch (err) {
      console.error(`[rate-limit] ${label} failed:`, errName(err));
    }
  };
  try {
    after(safe);
  } catch {
    void safe();
  }
}

/** One outage signal, at most once a minute per process; the alert opens at 3 signals within an hour (all instances). */
export function noteOutage(_err?: unknown, now: Date = new Date()): void {
  if (now.getTime() - lastOutageNoteAt < MINUTE) return;
  lastOutageNoteAt = now.getTime();
  schedule('outage signal', async () => {
    const count = await recordWindowedSignal(OUTAGE_KIND, now);
    if (count >= RATE_LIMIT_OUTAGE_THRESHOLD) {
      await raiseAlertWithEmail({
        tenantId: null,
        kind: OUTAGE_KIND,
        detail: { signalsInLastHour: count },
        summary: 'Upstash rate limiting failed 3 times within an hour; sign-in and signup limits are falling back to per-instance memory.',
      }, now);
    }
  });
}

/** This deployment has no (valid) Upstash configuration: at most once an hour per process. */
export function noteConfigMissing(missing: string[], now: Date = new Date()): void {
  if (lastConfigNoteAt && now.getTime() - lastConfigNoteAt < HOUR) return;
  lastConfigNoteAt = now.getTime();
  schedule('config alert', async () => {
    await raiseAlertWithEmail({
      tenantId: null,
      kind: CONFIG_KIND,
      detail: { missing },
      summary: `Rate limiting isn't configured on this deployment (${missing.join(', ')}); sign-in and signup limits are per-instance memory only.`,
    }, now);
  });
}

/**
 * Run by the notice-delivery cron: resolve the outage alert after an hour with no signal, and the config alert when
 * this environment's configuration builds (the same builder the store uses).
 */
export async function resolveRateLimitSignals(now: Date = new Date()): Promise<void> {
  const last = await lastSignalAt(OUTAGE_KIND);
  const outageQuiet = !last || now.getTime() - last.getTime() >= HOUR;
  const configOk = buildUpstash().ok;
  if (!outageQuiet && !configOk) return;
  await withLockedPool(async (db) => {
    if (outageQuiet) await resolveAlert(db, { tenantId: null, kind: OUTAGE_KIND }, now, 'no outage signal for an hour');
    if (configOk) await resolveAlert(db, { tenantId: null, kind: CONFIG_KIND }, now, 'configuration present');
  });
}

/** Test hook: forget the per-process throttles. */
export function __resetSignalThrottlesForTests(): void {
  lastOutageNoteAt = 0;
  lastConfigNoteAt = 0;
}
