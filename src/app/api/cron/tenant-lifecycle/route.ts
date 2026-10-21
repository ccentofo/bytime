import { NextRequest, NextResponse } from 'next/server';
import React from 'react';
import { eq, or, and, isNull } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { getDbForUrl } from '@/db';
import { workspaceSettings } from '@/db/schema';
import { formatInstant, isValidTimeZone } from '@/lib/calendar-date';
import { checkCronRateLimit } from '@/lib/rate-limit';
import { nextLifecycleActions, type LifecycleTenant, type NoticeDue } from '@/lib/tenant/lifecycle';
import { sendTenantNotice, type TenantNoticeTarget } from '@/lib/tenant/notices';
import { invalidateTenant } from '@/lib/tenant/registry';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { stripe } from '@/lib/billing/stripe';
import {
  POST_END_RETENTION_DAYS,
  SUSPENSION_NOTICE_DAYS,
  DELETION_SLA_DAYS,
} from '@/lib/tenant/lifecycle-config';
import { resend, EMAIL_FROM, isEmailEnabled } from '@/lib/email/client';
import { TrialEndingEmail } from '@/lib/email/templates/trial-ending';
import { TrialEndedEmail } from '@/lib/email/templates/trial-ended';
import { SuspensionWarningEmail } from '@/lib/email/templates/suspension-warning';
import { SuspendedEmail } from '@/lib/email/templates/suspended';
import { SubscriptionEndedEmail } from '@/lib/email/templates/subscription-ended';
import { DeletionScheduledEmail } from '@/lib/email/templates/deletion-scheduled';

const FALLBACK_TIMEZONE = 'America/New_York';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type TenantRow = typeof tenants.$inferSelect;

/** Days remaining from `now` to `target`, rounded up — matches how the warning emails phrase it. */
function daysUntil(now: Date, target: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / MS_PER_DAY));
}

/** Build and send the email for one due notice. Unknown kinds are logged and skipped. */
async function sendNoticeForKind(
  kind: string,
  scheduledFor: Date,
  tenant: TenantNoticeTarget,
  tenantName: string,
  appUrl: string,
  timezone: string,
  now: Date,
): Promise<boolean> {
  const trialReminderMatch = /^trial-reminder-(\d+)d$/.exec(kind);
  if (trialReminderMatch) {
    const daysLeft = Number(trialReminderMatch[1]);
    return sendTenantNotice({
      tenant, kind, scheduledFor,
      subject: `Your ${tenantName} trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      react: React.createElement(TrialEndingEmail, {
        tenantName, daysLeft, appUrl,
        trialEndsAtFormatted: formatInstant(scheduledFor, timezone, 'MMMM D, YYYY'),
      }),
    });
  }

  switch (kind) {
    case 'trial-ended':
      return sendTenantNotice({
        tenant, kind, scheduledFor,
        subject: `Your ${tenantName} trial has ended`,
        react: React.createElement(TrialEndedEmail, { tenantName, appUrl }),
      });
    case 'suspension-warning':
      return sendTenantNotice({
        tenant, kind, scheduledFor,
        subject: `${tenantName} will be suspended soon`,
        react: React.createElement(SuspensionWarningEmail, {
          tenantName, appUrl, daysUntilSuspension: daysUntil(now, scheduledFor) || SUSPENSION_NOTICE_DAYS,
        }),
      });
    case 'suspended':
      return sendTenantNotice({
        tenant, kind, scheduledFor,
        subject: `${tenantName} has been suspended`,
        react: React.createElement(SuspendedEmail, { tenantName, appUrl }),
      });
    case 'deletion-notice':
      return sendTenantNotice({
        tenant, kind, scheduledFor,
        subject: `${tenantName} is scheduled for deletion`,
        react: React.createElement(DeletionScheduledEmail, {
          tenantName, appUrl, isFinalReminder: false,
          deletionDateFormatted: formatInstant(scheduledFor, timezone, 'MMMM D, YYYY'),
        }),
      });
    case 'deletion-final-reminder':
      return sendTenantNotice({
        tenant, kind, scheduledFor,
        subject: `Final reminder: ${tenantName} will be deleted soon`,
        react: React.createElement(DeletionScheduledEmail, {
          tenantName, appUrl, isFinalReminder: true,
          deletionDateFormatted: formatInstant(scheduledFor, timezone, 'MMMM D, YYYY'),
        }),
      });
    default:
      console.error(`tenant-lifecycle cron: unknown notice kind "${kind}" for tenant ${tenant.id}`);
      return false;
  }
}

async function resolveTimezone(dbUrl: string): Promise<string> {
  const db = getDbForUrl(dbUrl);
  const [row] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
  return row?.timezone && isValidTimeZone(row.timezone) ? row.timezone : FALLBACK_TIMEZONE;
}

/** D9: cancel the Stripe subscription and move the tenant onto the normal subscription-ended path. */
async function terminateForNonPayment(tenant: TenantRow, now: Date): Promise<void> {
  if (tenant.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(tenant.stripeSubscriptionId);
    } catch (err) {
      // Already canceled, or Stripe is unreachable — either way, the tenant has been unpaid for
      // SUSPENDED_DAYS_UNTIL_TERMINATION days; proceed with the local state change regardless.
      console.error(`tenant-lifecycle cron: failed to cancel Stripe subscription for ${tenant.slug}:`, err);
    }
  }
  const deletionScheduledFor = tenant.deletionScheduledFor
    ?? new Date(now.getTime() + POST_END_RETENTION_DAYS * MS_PER_DAY);
  await controlDb.update(tenants).set({
    subscriptionEndedAt: now,
    deletionScheduledFor,
    status: 'active',
    updatedAt: now,
  }).where(eq(tenants.id, tenant.id));
  invalidateTenant(tenant.slug);

  await sendTenantNotice({
    tenant: {
      id: tenant.id,
      // T7: dbUrlEncrypted is only null once tombstoned ('deleted') — this tenant was 'suspended'
      // moments ago, so it still has one.
      dbUrl: decrypt(tenant.dbUrlEncrypted!),
      signupEmail: tenant.signupEmail,
      billingEmail: tenant.billingEmail,
    },
    kind: 'subscription-ended',
    scheduledFor: deletionScheduledFor,
    subject: `Your ${tenant.name} subscription has ended`,
    react: React.createElement(SubscriptionEndedEmail, {
      tenantName: tenant.name,
      retentionDays: POST_END_RETENTION_DAYS,
      appUrl: tenantBaseUrl(tenant.slug),
    }),
  });
}

interface RunSummary {
  tenantsChecked: number;
  noticesSent: number;
  suspended: string[];
  terminated: string[];
  readyForDeletion: { slug: string; deletionScheduledFor: string; overdue: boolean }[];
  failed: string[];
}

async function sendOpsDigest(summary: RunSummary): Promise<void> {
  const opsEmail = process.env.OPS_ALERT_EMAIL;
  if (!opsEmail || !isEmailEnabled() || !resend) return;

  const nothingToReport = summary.readyForDeletion.length === 0 && summary.failed.length === 0;
  if (nothingToReport) return; // D4: no email when there's nothing for the founder to do.

  const lines: string[] = [];
  if (summary.readyForDeletion.length > 0) {
    lines.push('Tenants due for deletion (run `npm run tenant:delete -- <slug> --yes`):');
    for (const t of summary.readyForDeletion) {
      lines.push(`  - ${t.slug}: scheduled ${t.deletionScheduledFor}${t.overdue ? '  [OVERDUE — past DELETION_SLA_DAYS]' : ''}`);
    }
  }
  if (summary.failed.length > 0) {
    lines.push('', 'Tenants that failed this run (see server logs):');
    for (const slug of summary.failed) lines.push(`  - ${slug}`);
  }
  lines.push('', `Checked ${summary.tenantsChecked} tenants, sent ${summary.noticesSent} notices, suspended ${summary.suspended.length}, terminated ${summary.terminated.length}.`);

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: opsEmail,
      subject: `CadenzPoint lifecycle digest: ${summary.readyForDeletion.length} due for deletion, ${summary.failed.length} failed`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('tenant-lifecycle cron: failed to send ops digest:', err);
  }
}

/**
 * Cron endpoint: daily tenant lifecycle processing (feature-plan-terms-compliance.md T4).
 * Computes `nextLifecycleActions()` for every active/suspended tenant, sends due notices, and
 * applies due state changes. Idempotent — safe to run more than once the same day.
 */
export async function GET(request: NextRequest) {
  const rateLimited = checkCronRateLimit(request);
  if (rateLimited) return rateLimited;

  const cronSecret = request.headers.get('x-cron-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const candidates = await controlDb.select().from(tenants).where(
    or(eq(tenants.status, 'active'), eq(tenants.status, 'suspended')),
  );

  const summary: RunSummary = {
    tenantsChecked: candidates.length,
    noticesSent: 0,
    suspended: [],
    terminated: [],
    readyForDeletion: [],
    failed: [],
  };

  for (const row of candidates) {
    try {
      const lifecycleTenant: LifecycleTenant = {
        status: row.status,
        subscriptionStatus: row.subscriptionStatus,
        trialEndsAt: row.trialEndsAt,
        pastDueSince: row.pastDueSince,
        suspendedAt: row.suspendedAt,
        subscriptionEndedAt: row.subscriptionEndedAt,
        deletionScheduledFor: row.deletionScheduledFor,
      };
      const actions = nextLifecycleActions(lifecycleTenant, now);

      if (actions.noticesDue.length > 0) {
        // T7: dbUrlEncrypted is only null for 'deleted'; `candidates` is active/suspended only.
        const dbUrl = decrypt(row.dbUrlEncrypted!);
        const timezone = await resolveTimezone(dbUrl);
        const appUrl = tenantBaseUrl(row.slug);
        const target: TenantNoticeTarget = {
          id: row.id, dbUrl, signupEmail: row.signupEmail, billingEmail: row.billingEmail,
        };
        for (const notice of actions.noticesDue satisfies NoticeDue[]) {
          const sent = await sendNoticeForKind(notice.kind, notice.scheduledFor, target, row.name, appUrl, timezone, now);
          if (sent) summary.noticesSent++;
        }
      }

      // setDeletionScheduledFor: only when still unset (guards against a race with this same check).
      if (actions.setDeletionScheduledFor) {
        await controlDb.update(tenants)
          .set({ deletionScheduledFor: actions.setDeletionScheduledFor, updatedAt: now })
          .where(and(eq(tenants.id, row.id), isNull(tenants.deletionScheduledFor)));
        invalidateTenant(row.slug);
      }

      // suspend: only when still active (guards against double-suspending on a retry).
      if (actions.suspend) {
        const updated = await controlDb.update(tenants)
          .set({ status: 'suspended', suspendedAt: now, updatedAt: now })
          .where(and(eq(tenants.id, row.id), eq(tenants.status, 'active')))
          .returning({ id: tenants.id });
        if (updated.length > 0) {
          invalidateTenant(row.slug);
          summary.suspended.push(row.slug);
        }
      }

      if (actions.terminateSubscription) {
        await terminateForNonPayment(row, now);
        summary.terminated.push(row.slug);
      }

      if (actions.readyForDeletion && row.deletionScheduledFor) {
        summary.readyForDeletion.push({
          slug: row.slug,
          deletionScheduledFor: row.deletionScheduledFor.toISOString(),
          overdue: now.getTime() - row.deletionScheduledFor.getTime() > DELETION_SLA_DAYS * MS_PER_DAY,
        });
      }
    } catch (err) {
      summary.failed.push(row.slug);
      console.error(`tenant-lifecycle cron: tenant ${row.slug} failed:`, err);
    }
  }

  await sendOpsDigest(summary);

  return NextResponse.json({ message: 'Tenant lifecycle processed', ...summary });
}
