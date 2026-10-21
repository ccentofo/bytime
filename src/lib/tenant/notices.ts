import 'server-only';
import type { ReactElement } from 'react';
import { eq, and } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenantNotices } from '@/db/control-plane/schema';
import { getDbForUrl } from '@/db';
import { users } from '@/db/schema';
import { resend, EMAIL_FROM, isEmailEnabled } from '@/lib/email/client';
import { NOTICE_RECIPIENTS } from './lifecycle-config';

/** The subset of a tenant row sendTenantNotice needs to resolve recipients and log the send. */
export interface TenantNoticeTarget {
  id: string;
  dbUrl: string;
  signupEmail: string | null;
  billingEmail: string | null;
}

/**
 * D10: active admins' emails, plus the Stripe billing email when one exists, deduplicated.
 * Falls back to the original signup email only if there's no active admin to reach.
 */
async function resolveRecipients(tenant: TenantNoticeTarget): Promise<string[]> {
  const emails = new Set<string>();

  if (NOTICE_RECIPIENTS.activeAdmins) {
    const db = getDbForUrl(tenant.dbUrl);
    const admins = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
    for (const admin of admins) emails.add(admin.email.toLowerCase());
  }

  if (NOTICE_RECIPIENTS.stripeBillingEmail && tenant.billingEmail) {
    emails.add(tenant.billingEmail.toLowerCase());
  }

  if (emails.size === 0 && NOTICE_RECIPIENTS.signupEmailFallbackOnly && tenant.signupEmail) {
    emails.add(tenant.signupEmail.toLowerCase());
  }

  return [...emails];
}

/**
 * §3.3/R14: the single entry point for every lifecycle email. Insert-before-send: the row in
 * `tenant_notices` is written FIRST, keyed on (tenant_id, kind, scheduled_for). If that insert
 * conflicts (already logged — a prior run already handled this exact notice), nothing is sent.
 * This is what makes a cron retry, or a second run the same day, a no-op instead of a duplicate
 * email — the uniqueness lives in the database, not in cron-side bookkeeping.
 *
 * Returns whether an email was actually sent this call.
 */
export async function sendTenantNotice(params: {
  tenant: TenantNoticeTarget;
  kind: string;
  scheduledFor: Date;
  subject: string;
  react: ReactElement;
}): Promise<boolean> {
  const recipients = await resolveRecipients(params.tenant);

  const inserted = await controlDb
    .insert(tenantNotices)
    .values({
      tenantId: params.tenant.id,
      kind: params.kind,
      scheduledFor: params.scheduledFor,
      recipients,
    })
    .onConflictDoNothing()
    .returning({ id: tenantNotices.id });

  if (inserted.length === 0) return false; // already logged for this (tenant, kind, scheduledFor)
  if (recipients.length === 0 || !isEmailEnabled() || !resend) return false;

  try {
    const result = await resend.emails.send({
      from: EMAIL_FROM,
      to: recipients,
      subject: params.subject,
      react: params.react,
    });
    await controlDb
      .update(tenantNotices)
      .set({ sentAt: new Date(), providerMessageId: result.data?.id ?? null })
      .where(eq(tenantNotices.id, inserted[0].id));
    return true;
  } catch (error) {
    console.error(`Failed to send tenant notice "${params.kind}" for tenant ${params.tenant.id}:`, error);
    return false;
  }
}
