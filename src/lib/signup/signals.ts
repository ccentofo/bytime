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
export const TURNSTILE_OUTAGE_THRESHOLD = 3;
export const TURNSTILE_HOSTNAME_MISMATCH_THRESHOLD = 3;

/**
 * Count one signal in a shared one-hour window (`<key>`), and record its time (`<key>:last`) — the resolution rule
 * ("quiet for an hour") reads the last time. Returns the count in the current window.
 */
async function recordWindowedSignal(key: string, now: Date): Promise<number> {
  const stale = new Date(now.getTime() - HOUR);
  const [row] = await controlDb.insert(signalCounters).values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: signalCounters.key,
      set: {
        // Audit R11: ISO strings with a cast — a raw Date in a `sql` fragment crashes drizzle's postgres-js driver.
        windowStart: sql`CASE WHEN ${signalCounters.windowStart} < ${stale.toISOString()}::timestamptz THEN ${now.toISOString()}::timestamptz ELSE ${signalCounters.windowStart} END`,
        count: sql`CASE WHEN ${signalCounters.windowStart} < ${stale.toISOString()}::timestamptz THEN 1 ELSE ${signalCounters.count} + 1 END`,
      },
    })
    .returning({ count: signalCounters.count });
  await controlDb.insert(signalCounters).values({ key: `${key}:last`, windowStart: now, count: 1 })
    .onConflictDoUpdate({ target: signalCounters.key, set: { windowStart: now, count: sql`${signalCounters.count} + 1` } });
  return row?.count ?? 1;
}

/** When the last signal for `key` happened (null = never). */
async function lastSignalAt(key: string): Promise<Date | null> {
  const [last] = await controlDb.select({ at: signalCounters.windowStart }).from(signalCounters)
    .where(sql`${signalCounters.key} = ${`${key}:last`}`).limit(1);
  return last?.at ?? null;
}

/**
 * Count one outage signal (network error / `internal-error` — never a user error) in a shared one-hour window; raise
 * `turnstile-outage` (immediate email + Sentry, once per incident) at ≥ 3 in the window.
 */
export async function recordTurnstileOutageSignal(now: Date = new Date()): Promise<number> {
  const count = await recordWindowedSignal('turnstile-outage', now);
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

/**
 * Audit S2: a valid token minted for another hostname. One is likely a user on an odd host; several in an hour mean
 * the widget/site-key setup is wrong and every signup is being refused → `turnstile-hostname-mismatch`.
 */
export async function recordTurnstileHostnameMismatch(reported: string, now: Date = new Date()): Promise<number> {
  const count = await recordWindowedSignal('turnstile-hostname-mismatch', now);
  if (count >= TURNSTILE_HOSTNAME_MISMATCH_THRESHOLD) {
    await raiseAlertWithEmail({
      tenantId: null,
      kind: 'turnstile-hostname-mismatch',
      detail: { mismatchesInLastHour: count, lastReportedHostname: reported },
      summary: `Turnstile tokens were issued for a hostname other than the apex ${count} times within an hour (last: "${reported}") — check the widget's hostname settings; those signups are refused.`,
    }, now);
  }
  return count;
}

/**
 * Audit S3/S5: Cloudflare rejected our secret (or a test secret is configured in production). Its own alert — env
 * presence says nothing about whether the secret is RIGHT — resolved by a successful siteverify or an hour without
 * recurrence.
 */
export async function recordTurnstileSecretRejected(codes: string[], now: Date = new Date()): Promise<void> {
  await recordWindowedSignal('turnstile-secret-rejected', now);
  await raiseAlertWithEmail({
    tenantId: null,
    kind: 'turnstile-secret-rejected',
    detail: { codes },
    summary: `Cloudflare rejected the Turnstile secret (${codes.join(', ')}) — every signup is refused until TURNSTILE_SECRET_KEY is fixed.`,
  }, now);
}

/** A siteverify just succeeded: the secret works (audit S3). */
export async function resolveTurnstileSecretRejected(now: Date = new Date()): Promise<void> {
  await withLockedPool((db) => resolveAlert(db, { tenantId: null, kind: 'turnstile-secret-rejected' }, now, 'siteverify succeeded'));
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
  const quiet = async (key: string) => {
    const last = await lastSignalAt(key);
    return !last || now.getTime() - last.getTime() >= HOUR;
  };
  const outageQuiet = await quiet('turnstile-outage');
  const hostnameQuiet = await quiet('turnstile-hostname-mismatch');
  const secretQuiet = await quiet('turnstile-secret-rejected');
  const configOk = !signupControlsEnabled() || missingSignupConfig().length === 0;
  await withLockedPool(async (db) => {
    if (outageQuiet) await resolveAlert(db, { tenantId: null, kind: 'turnstile-outage' }, now, 'no outage signal for an hour');
    if (hostnameQuiet) await resolveAlert(db, { tenantId: null, kind: 'turnstile-hostname-mismatch' }, now, 'no mismatch for an hour');
    if (secretQuiet) await resolveAlert(db, { tenantId: null, kind: 'turnstile-secret-rejected' }, now, 'no rejection for an hour');
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

/** Test hook (audit S4): the shared window logic, on a caller-chosen key, so the integration test never touches the
 * live `turnstile-*` counters. */
export const recordWindowedSignalForTests = (key: string, now: Date) => recordWindowedSignal(key, now);
