import 'server-only';
import React from 'react';
import { render } from '@react-email/components';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { tenantNotices } from '@/db/control-plane/schema';
import { withLockedPool, withTenantLock, type ControlTx } from '@/db/control-plane/locked';
import { getDbForUrl } from '@/db';
import { users, workspaceSettings } from '@/db/schema';
import { decrypt } from '@/lib/encryption';
import { resend, EMAIL_FROM, isEmailEnabled } from '@/lib/email/client';
import { CRON_SEND_INTERVAL_MS } from '@/lib/email/rate';
import { calendarDayOf, canonicalTimeZone, formatCalendarDate } from '@/lib/calendar-date';
import { tenantBaseUrl } from './host';
import { addDays, isNoticeSuperseded, type NoticeKind } from './lifecycle';
import { DELETION_NOTICE_DAYS, NOTICE_RECIPIENTS, PAYMENT_GRACE_DAYS, SUSPENDED_DAYS_UNTIL_TERMINATION, SUSPENSION_NOTICE_DAYS } from './lifecycle-config';
import { toLifecycleFacts } from './registry';
import { raiseAlert, readTenant, updateTenantGuarded, type TenantRow } from './lifecycle-store';
import { TrialEndingEmail } from '@/lib/email/templates/trial-ending';
import { TrialEndedEmail } from '@/lib/email/templates/trial-ended';
import { PaymentFailedEmail } from '@/lib/email/templates/payment-failed';
import { SuspensionWarningEmail } from '@/lib/email/templates/suspension-warning';
import { SuspendedEmail } from '@/lib/email/templates/suspended';
import { SubscriptionEndedEmail } from '@/lib/email/templates/subscription-ended';
import { DeletionScheduledEmail } from '@/lib/email/templates/deletion-scheduled';
import { PolicySuspendedEmail } from '@/lib/email/templates/policy-suspended';

/**
 * Lifecycle notice OUTBOX (feature-plan-terms-compliance-fixes.md §4.5, R14 proof of notice).
 *
 * - enqueueNotice: inside the state change's locked transaction; idempotent on (tenant, kind, anchor).
 * - deliverNotice: claim under the tenant lock → supersede check on current facts → freeze the exact message once →
 *   commit → send with an idempotency key → record sent ONLY when Resend returns a message id.
 * - deliverPendingNotices: the 10-minute delivery cron (and the lifecycle cron) retry every pending row.
 */

const LEASE_MINUTES = 10;
const REFREEZE_AFTER_HOURS = 23; // Resend remembers an idempotency key for 24 h
// throttleMs: the shared cron send budget (≤ 2 sends/second, src/lib/email/rate.ts).
const timing = { sendTimeoutMs: 10_000, backoffBaseMs: 1000, throttleMs: CRON_SEND_INTERVAL_MS };

/** Integration tests only: shrink the send timeout / retry backoff / throttle so failure paths run quickly. */
export function setNoticeTimingForTests(t: Partial<typeof timing>): void {
  Object.assign(timing, t);
}

/** Enqueue (inside a locked transaction). A superseded, never-sent row is revived with a fresh payload and key. */
export async function enqueueNotice(tx: ControlTx, tenantId: string, kind: NoticeKind, anchor: Date): Promise<string | null> {
  const [row] = await tx.insert(tenantNotices)
    .values({ tenantId, kind, scheduledFor: anchor })
    .onConflictDoUpdate({
      target: [tenantNotices.tenantId, tenantNotices.kind, tenantNotices.scheduledFor],
      set: {
        supersededAt: null, payload: null, payloadFrozenAt: null, firstAttemptAt: null, attempts: 0, lastError: null,
        forcedAt: null, forcedReason: null, forcedAuditId: null,
        idempotencyGeneration: sql`${tenantNotices.idempotencyGeneration} + 1`,
      },
      setWhere: and(isNull(tenantNotices.sentAt), isNotNull(tenantNotices.supersededAt)),
    })
    .returning({ id: tenantNotices.id });
  return row?.id ?? null;
}

interface FrozenPayload {
  to: string[];
  subject: string;
  html: string;
  stated: Record<string, string>;
}

/** D10: active admins + Stripe billing email; the signup email whenever there is no active admin. */
async function resolveRecipientsAndTimezone(row: TenantRow): Promise<{ to: string[]; timeZone: string }> {
  const emails = new Set<string>();
  let timeZone = 'America/New_York';
  let hasActiveAdmin = false;
  if (row.dbUrlEncrypted) {
    const db = getDbForUrl(decrypt(row.dbUrlEncrypted));
    if (NOTICE_RECIPIENTS.activeAdmins) {
      const admins = await db.select({ email: users.email }).from(users)
        .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
      hasActiveAdmin = admins.length > 0;
      for (const a of admins) emails.add(a.email.toLowerCase());
    }
    const [settings] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
    timeZone = canonicalTimeZone(settings?.timezone) ?? timeZone;
  }
  if (NOTICE_RECIPIENTS.stripeBillingEmail && row.billingEmail) emails.add(row.billingEmail.toLowerCase());
  if (!hasActiveAdmin && row.signupEmail) emails.add(row.signupEmail.toLowerCase());
  return { to: [...emails], timeZone };
}

/** Render a notice from the CURRENT facts (called once per generation, then frozen). */
async function renderNotice(kind: string, anchor: Date, row: TenantRow, timeZone: string, now: Date): Promise<{ subject: string; html: string; stated: Record<string, string> }> {
  const fmt = (d: Date) => formatCalendarDate(calendarDayOf(d, timeZone), 'MMMM D, YYYY');
  const appUrl = tenantBaseUrl(row.slug);
  const tenantName = row.name;
  let subject: string;
  let element: React.ReactElement;
  const stated: Record<string, string> = {};
  switch (kind) {
    case 'trial-reminder-7d':
    case 'trial-reminder-1d': {
      stated.trialEndsAt = fmt(anchor);
      subject = `Your ${tenantName} trial ends on ${stated.trialEndsAt}`;
      element = React.createElement(TrialEndingEmail, { tenantName, trialEndsAtFormatted: stated.trialEndsAt, appUrl });
      break;
    }
    case 'trial-ended': {
      stated.deletionDate = fmt(row.deletionScheduledFor ?? addDays(now, 90));
      subject = `Your ${tenantName} trial has ended`;
      element = React.createElement(TrialEndedEmail, { tenantName, deletionDateFormatted: stated.deletionDate, appUrl });
      break;
    }
    case 'payment-failed': {
      stated.suspensionDate = fmt(addDays(anchor, PAYMENT_GRACE_DAYS));
      subject = `Payment failed for ${tenantName}`;
      element = React.createElement(PaymentFailedEmail, { tenantName, suspensionDateFormatted: stated.suspensionDate, appUrl });
      break;
    }
    case 'suspension-warning': {
      // Never earlier than the real suspension: max(P + 15d, now + 3d).
      const graceEnd = addDays(anchor, PAYMENT_GRACE_DAYS);
      const earliest = addDays(now, SUSPENSION_NOTICE_DAYS);
      stated.suspensionDate = fmt(graceEnd.getTime() >= earliest.getTime() ? graceEnd : earliest);
      subject = `${tenantName} will be suspended on ${stated.suspensionDate}`;
      element = React.createElement(SuspensionWarningEmail, { tenantName, suspensionDateFormatted: stated.suspensionDate, appUrl });
      break;
    }
    case 'suspended': {
      stated.terminationDate = fmt(addDays(anchor, SUSPENDED_DAYS_UNTIL_TERMINATION));
      subject = `${tenantName} has been suspended`;
      element = React.createElement(SuspendedEmail, { tenantName, terminationDateFormatted: stated.terminationDate, appUrl });
      break;
    }
    case 'subscription-ended': {
      stated.deletionDate = fmt(row.deletionScheduledFor ?? addDays(anchor, 90));
      subject = `Your ${tenantName} subscription has ended`;
      element = React.createElement(SubscriptionEndedEmail, { tenantName, deletionDateFormatted: stated.deletionDate, appUrl });
      break;
    }
    case 'deletion-notice':
    case 'deletion-final-reminder': {
      stated.deletionDate = fmt(row.deletionScheduledFor!);
      const isFinalReminder = kind === 'deletion-final-reminder';
      subject = isFinalReminder ? `Final reminder: ${tenantName} will be deleted on ${stated.deletionDate}` : `${tenantName} is scheduled for deletion on ${stated.deletionDate}`;
      element = React.createElement(DeletionScheduledEmail, { tenantName, deletionDateFormatted: stated.deletionDate, isFinalReminder, appUrl });
      break;
    }
    case 'policy-suspended': {
      stated.suspendedAt = fmt(anchor);
      subject = `${tenantName} is on hold`;
      element = React.createElement(PolicySuspendedEmail, { tenantName, suspendedAtFormatted: stated.suspendedAt });
      break;
    }
    default:
      throw new Error(`Unknown notice kind: ${kind}`);
  }
  return { subject, html: await render(element), stated };
}

export type DeliveryOutcome = 'sent' | 'superseded' | 'skipped' | 'failed';

/** Deliver one notice. Safe to call concurrently from both crons and the webhook: the claim lease serializes. */
export async function deliverNotice(noticeId: string, now: Date = new Date()): Promise<DeliveryOutcome> {
  const notice = await withLockedPool(async (db) =>
    (await db.select().from(tenantNotices).where(eq(tenantNotices.id, noticeId)).limit(1))[0]);
  if (!notice) return 'skipped';
  // Email off: don't claim or freeze anything, so the message is rendered fresh (current dates, current
  // recipients) once email works again.
  if (!isEmailEnabled() || !resend) {
    await withLockedPool((db) => db.update(tenantNotices).set({ lastError: 'email disabled' })
      .where(and(eq(tenantNotices.id, noticeId), isNull(tenantNotices.sentAt))));
    return 'failed';
  }

  // Steps 1–3 under the tenant lock: claim, supersede check, freeze once. Commit releases the lock before sending.
  const prepared = await withTenantLock(notice.tenantId, async (tx) => {
    const leaseCutoff = new Date(now.getTime() - LEASE_MINUTES * 60_000);
    const [claimed] = await tx.update(tenantNotices)
      .set({ attempts: sql`${tenantNotices.attempts} + 1`, lastAttemptAt: now })
      .where(and(
        eq(tenantNotices.id, noticeId),
        isNull(tenantNotices.sentAt),
        isNull(tenantNotices.forcedAt),
        isNull(tenantNotices.supersededAt),
        or(isNull(tenantNotices.lastAttemptAt), lt(tenantNotices.lastAttemptAt, leaseCutoff)),
      ))
      .returning();
    if (!claimed) return null;

    const row = await readTenant(tx, claimed.tenantId);
    if (!row || isNoticeSuperseded(claimed.kind, claimed.scheduledFor, toLifecycleFacts(row), now)) {
      await tx.update(tenantNotices).set({ supersededAt: now }).where(eq(tenantNotices.id, noticeId));
      return { superseded: true as const };
    }

    let payload = claimed.payload as FrozenPayload | null;
    let generation = claimed.idempotencyGeneration;
    const stale = claimed.firstAttemptAt !== null
      && now.getTime() - claimed.firstAttemptAt.getTime() > REFREEZE_AFTER_HOURS * 3600_000;
    if (!payload || stale) {
      let current = row;
      if (claimed.kind === 'deletion-notice' && row.deletionScheduledFor) {
        // The stated deletion date is never earlier than the real one: push D before rendering.
        const minD = addDays(now, DELETION_NOTICE_DAYS);
        if (row.deletionScheduledFor.getTime() < minD.getTime()) {
          current = await updateTenantGuarded(tx, row, { deletionScheduledFor: minD }, now);
        }
      }
      const { to, timeZone } = await resolveRecipientsAndTimezone(current);
      if (to.length === 0) {
        // Never freeze an empty recipient list: the next attempt re-resolves (an admin or billing email may appear).
        await tx.update(tenantNotices).set({ lastError: 'no recipients' }).where(eq(tenantNotices.id, noticeId));
        return { superseded: false as const, noRecipients: true as const };
      }
      const rendered = await renderNotice(claimed.kind, claimed.scheduledFor, current, timeZone, now);
      payload = { to, ...rendered };
      if (stale) generation += 1;
      await tx.update(tenantNotices).set({
        payload, payloadFrozenAt: now, idempotencyGeneration: generation,
        ...(stale ? { firstAttemptAt: null } : {}),
      }).where(eq(tenantNotices.id, noticeId));
    }
    return { superseded: false as const, payload, generation, tenantId: claimed.tenantId, kind: claimed.kind, firstAttemptAt: stale ? null : claimed.firstAttemptAt };
  });

  if (!prepared) return 'skipped';
  if (prepared.superseded) return 'superseded';
  if ('noRecipients' in prepared) return 'failed';
  const { payload, generation } = prepared;

  const fail = async (message: string) => {
    await withLockedPool((db) => db.update(tenantNotices).set({ lastError: message }).where(eq(tenantNotices.id, noticeId)));
    return 'failed' as const;
  };
  if (!resend) return fail('email disabled');

  await withLockedPool((db) => db.update(tenantNotices)
    // A raw SQL fragment bypasses the column's Date mapping: pass an ISO string with an explicit cast.
    .set({ firstAttemptAt: sql`coalesce(${tenantNotices.firstAttemptAt}, ${now.toISOString()}::timestamptz)` })
    .where(eq(tenantNotices.id, noticeId)));

  // Step 4: send exactly the frozen payload. Retry 429 / concurrent-409 briefly within this claim.
  const key = `${noticeId}:${generation}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let outcome: { data: { id: string } | null; error: { name?: string; message?: string; statusCode?: number } | null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await Promise.race([
        resend.emails.send({ from: EMAIL_FROM, to: payload.to, subject: payload.subject, html: payload.html }, { idempotencyKey: key }) as Promise<typeof outcome>,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('send timed out')), timing.sendTimeoutMs); }),
      ]);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err)); // retried later with the same key
    } finally {
      clearTimeout(timer);
    }
    if (outcome.data?.id) {
      await withLockedPool((db) => db.update(tenantNotices)
        .set({ sentAt: now, providerMessageId: outcome.data!.id, recipients: payload.to, lastError: null })
        .where(eq(tenantNotices.id, noticeId)));
      return 'sent';
    }
    const name = outcome.error?.name ?? '';
    if (name === 'invalid_idempotent_request') {
      await withLockedPool((db) => raiseAlert(db, { tenantId: prepared.tenantId, kind: 'notice-idempotency-mismatch', dedupKey: noticeId }, now));
      return fail(`idempotency mismatch: ${outcome.error?.message ?? ''}`);
    }
    const retryable = name === 'concurrent_idempotent_requests' || name === 'rate_limit_exceeded' || outcome.error?.statusCode === 429;
    if (!retryable || attempt === 3) return fail(`${name}: ${outcome.error?.message ?? 'unknown error'}`);
    await new Promise((r) => setTimeout(r, timing.backoffBaseMs * 2 ** attempt));
  }
  return 'failed';
}

/** Deliver every pending notice (delivery cron + lifecycle cron), throttled under Resend's 10/s team limit. */
export async function deliverPendingNotices(budgetMs: number, now?: Date, onlyTenantIds?: string[]): Promise<Record<DeliveryOutcome, number>> {
  const started = Date.now();
  const batchStart = now ?? new Date();
  const counts: Record<DeliveryOutcome, number> = { sent: 0, superseded: 0, skipped: 0, failed: 0 };
  const leaseCutoff = new Date(batchStart.getTime() - LEASE_MINUTES * 60_000);
  const pending = await withLockedPool((db) => db.select({ id: tenantNotices.id }).from(tenantNotices)
    .where(and(
      isNull(tenantNotices.sentAt), isNull(tenantNotices.forcedAt), isNull(tenantNotices.supersededAt),
      or(isNull(tenantNotices.lastAttemptAt), lt(tenantNotices.lastAttemptAt, leaseCutoff)),
      onlyTenantIds ? inArray(tenantNotices.tenantId, onlyTenantIds) : undefined,
    ))
    .orderBy(asc(tenantNotices.createdAt))
    .limit(500));
  for (const { id } of pending) {
    if (Date.now() - started > budgetMs) break;
    try {
      counts[await deliverNotice(id, now ?? new Date())]++; // each send stamped with its own time
    } catch (err) {
      console.error(`Notice ${id} delivery error:`, err);
      counts.failed++;
    }
    await new Promise((r) => setTimeout(r, timing.throttleMs)); // ≤ 2 sends/second
  }
  return counts;
}

/** Unit tests only: the current delivery timing (default throttle is the shared 500 ms budget). */
export function getNoticeTimingForTests(): Readonly<typeof timing> {
  return { ...timing };
}
