import 'server-only';
import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { signalCounters, signups } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { resolveAlert } from '@/lib/tenant/lifecycle-store';
import { raiseAlertWithEmail } from '@/lib/tenant/ops-alert-email';
import { SIGNUP_IP_HASH_RETENTION_HOURS } from '@/lib/tenant/lifecycle-config';
import { missingSignupConfig, signupControlsEnabled } from './controls';

/**
 * Signup alert signals (feature-plan-launch-blockers.md P5): Turnstile outage counting, the config-missing alert, and
 * their resolution by the 10-minute notice-delivery cron; plus the IP-hash nulling job (LB-D5: ≤ ~25 h).
 */

const HOUR = 3_600_000;
const OUTAGE_WINDOW_KEY = 'turnstile-outage';
const OUTAGE_LAST_KEY = 'turnstile-outage:last';
export const TURNSTILE_OUTAGE_THRESHOLD = 3;

/**
 * Count one outage signal (network error / `internal-error` — never a user error) in a shared one-hour window; raise
 * `turnstile-outage` (immediate email + Sentry, once per incident) at ≥ 3 in the window.
 */
export async function recordTurnstileOutageSignal(now: Date = new Date()): Promise<number> {
  const stale = new Date(now.getTime() - HOUR);
  const [row] = await controlDb.insert(signalCounters).values({ key: OUTAGE_WINDOW_KEY, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: signalCounters.key,
      set: {
        windowStart: sql`CASE WHEN ${signalCounters.windowStart} < ${stale} THEN ${now} ELSE ${signalCounters.windowStart} END`,
        count: sql`CASE WHEN ${signalCounters.windowStart} < ${stale} THEN 1 ELSE ${signalCounters.count} + 1 END`,
      },
    })
    .returning({ count: signalCounters.count });
  // The last signal's time (window_start of the `:last` key) drives resolution: quiet for an hour → resolved.
  await controlDb.insert(signalCounters).values({ key: OUTAGE_LAST_KEY, windowStart: now, count: 1 })
    .onConflictDoUpdate({ target: signalCounters.key, set: { windowStart: now, count: sql`${signalCounters.count} + 1` } });

  const count = row?.count ?? 1;
  if (count >= TURNSTILE_OUTAGE_THRESHOLD) {
    await raiseAlertWithEmail({
      tenantId: null,
      kind: 'turnstile-outage',
      detail: { signalsInLastHour: count },
      summary: `Turnstile verification failed for an outage reason ${count} times within an hour — signups are being refused (fail closed).`,
    }, now);
  }
  return count;
}

/** Required production config (Turnstile secret / IP salt) is missing → `signup-config-missing` (immediate email). */
export async function raiseSignupConfigMissing(missing: string[], now: Date = new Date()): Promise<void> {
  await raiseAlertWithEmail({
    tenantId: null,
    kind: 'signup-config-missing',
    detail: { missing },
    summary: `Signup controls are on but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set — every signup is refused until it is.`,
  }, now);
}

/**
 * Run by the notice-delivery cron: resolve `turnstile-outage` once no outage signal has been seen for an hour, and
 * `signup-config-missing` once the required env is present (or the controls are off). A later occurrence raises a
 * NEW alert row — and a new immediate email.
 */
export async function resolveSignupSignals(now: Date = new Date()): Promise<void> {
  const [last] = await controlDb.select({ at: signalCounters.windowStart }).from(signalCounters)
    .where(sql`${signalCounters.key} = ${OUTAGE_LAST_KEY}`).limit(1);
  const quiet = !last || now.getTime() - last.at.getTime() >= HOUR;
  const configOk = !signupControlsEnabled() || missingSignupConfig().length === 0;
  await withLockedPool(async (db) => {
    if (quiet) await resolveAlert(db, { tenantId: null, kind: 'turnstile-outage' }, now, 'no outage signal for an hour');
    if (configOk) await resolveAlert(db, { tenantId: null, kind: 'signup-config-missing' }, now, 'configuration present');
  });
}

/** LB-D5: drop the IP hash from signup rows older than 24 h (runs every 10 minutes → bound ≈ 24 h 10 min). */
export async function nullExpiredSignupIpHashes(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SIGNUP_IP_HASH_RETENTION_HOURS * HOUR);
  const rows = await controlDb.update(signups).set({ ipHash: null })
    .where(and(isNotNull(signups.ipHash), lt(signups.createdAt, cutoff)))
    .returning({ id: signups.id });
  return rows.length;
}
