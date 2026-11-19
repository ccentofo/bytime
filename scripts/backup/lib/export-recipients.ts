/**
 * The export task's copy of D10 (feature-plan-cloud-export.md §6.3 step 2). `src/lib/tenant/notices.ts`'s
 * `resolveRecipientsAndTimezone` is `server-only` with `@/` imports, so the backup image can't call it; one shared
 * integration fixture (T29) runs both against the same workspace states and requires equal results.
 *
 * D10: active admins of the workspace, plus the Stripe billing email, plus the signup email when there is no active
 * admin (`NOTICE_RECIPIENTS`, lifecycle-config.ts). Lowercased and deduplicated. The time zone is the workspace's
 * `workspace_settings.timezone`, canonicalised, defaulting to America/New_York (as notices.ts).
 *
 * The export adds the verified `--extra` address; for a `policy_hold` workspace whose export isn't re-enabled the
 * recipients are the extra address ONLY (A1): its admins are who the hold protects against.
 */
import type postgres from 'postgres';
import { NOTICE_RECIPIENTS } from '../../../src/lib/tenant/lifecycle-config';
import { canonicalTimeZone } from '../../../src/lib/calendar-date';

export const MAX_EXPORT_RECIPIENTS = 50;
export const DEFAULT_TIME_ZONE = 'America/New_York';

/** The control-plane facts D10 reads (the tenants row). */
export interface RecipientTenantFacts {
  billingEmail: string | null;
  signupEmail: string | null;
}

type WorkspaceSql = postgres.Sql | postgres.ReservedSql;

/** D10 exactly as notices.ts resolves it, from a connection to the workspace database. */
export async function resolveD10(row: RecipientTenantFacts, workspace: WorkspaceSql): Promise<{ to: string[]; timeZone: string }> {
  const emails = new Set<string>();
  let hasActiveAdmin = false;
  if (NOTICE_RECIPIENTS.activeAdmins) {
    const admins = await workspace<{ email: string }[]>`SELECT email FROM users WHERE role = 'admin' AND is_active = true`;
    hasActiveAdmin = admins.length > 0;
    for (const a of admins) emails.add(a.email.toLowerCase());
  }
  const [settings] = await workspace<{ timezone: string | null }[]>`SELECT timezone FROM workspace_settings LIMIT 1`;
  const timeZone = canonicalTimeZone(settings?.timezone) ?? DEFAULT_TIME_ZONE;
  if (NOTICE_RECIPIENTS.stripeBillingEmail && row.billingEmail) emails.add(row.billingEmail.toLowerCase());
  if (!hasActiveAdmin && row.signupEmail) emails.add(row.signupEmail.toLowerCase());
  return { to: [...emails], timeZone };
}

/** Whether the A1 rule applies: suspended for policy with export not re-enabled (the status is irrelevant). */
export function isExtraOnly(t: { suspensionReason: string | null; policyExportAllowed: boolean }): boolean {
  return t.suspensionReason === 'policy' && !t.policyExportAllowed;
}

/**
 * The export's recipients: the extra address only under A1, otherwise D10 plus the extra address. Lowercased and
 * deduplicated. The time zone is always the workspace's.
 */
export async function resolveExportRecipients(
  row: RecipientTenantFacts & { suspensionReason: string | null; policyExportAllowed: boolean },
  workspace: WorkspaceSql,
  extra: string | undefined,
): Promise<{ to: string[]; timeZone: string; extraOnly: boolean }> {
  const d10 = await resolveD10(row, workspace);
  const extraOnly = isExtraOnly(row);
  const set = new Set<string>(extraOnly ? [] : d10.to);
  if (extra) set.add(extra.toLowerCase());
  return { to: [...set], timeZone: d10.timeZone, extraOnly };
}

/** The deliver-only recipient-count refusals (§6.3 step 2). */
export function recipientCountRefusal(n: number): 'no-recipients' | 'too-many-recipients' | null {
  if (n === 0) return 'no-recipients';
  if (n > MAX_EXPORT_RECIPIENTS) return 'too-many-recipients';
  return null;
}
