import type { userRoleEnum } from '@/db/schema';

/**
 * Tenant lifecycle business rules (feature-plan-terms-compliance.md §0, decisions D1–D13).
 *
 * Every value here is a business decision backed by the Terms of Service / Privacy Policy
 * (business/legal/). Changing one may require changing those documents first — check the
 * cited clause before editing.
 */

type UserRole = (typeof userRoleEnum.enumValues)[number];

// ── Trial (Terms §3) ────────────────────────────────────────────────────────

/** D1: trial length. `trial_ends_at = provisioned_at + TRIAL_DAYS` (exact timestamp, not end of day). */
export const TRIAL_DAYS = 30;

/**
 * D1 (backfill only): a tenant already mid-trial when the backfill runs gets at least this many
 * days from the backfill time, so nobody flips to read-only without warning.
 */
export const TRIAL_BACKFILL_MIN_DAYS = 14;

/** D2: trial-ending reminders, in days before `trial_ends_at`. A `trial-ended` notice is also sent at the end. */
export const TRIAL_REMINDER_DAYS_BEFORE: readonly number[] = [7, 1];

// ── Retention and deletion (Terms §3.3, §9.2, §9.3; Privacy §7) ─────────────

/** Days data is kept after a trial ends unpurchased or a subscription ends (§3.3, §9.2). */
export const POST_END_RETENTION_DAYS = 90;

/** D3: the contractual deletion notice, in days before `deletion_scheduled_for` (§3.3 "at least 14 days"). */
export const DELETION_NOTICE_DAYS = 14;

/** D3: courtesy final reminder, in days before `deletion_scheduled_for`. Not the contractual notice. */
export const DELETION_FINAL_REMINDER_DAYS = 3;

/**
 * D4: false = the cron only flags tenants due for deletion; the founder runs `tenant:delete`.
 * Due tenants must be deleted within DELETION_SLA_DAYS of `deletion_scheduled_for` (Privacy §7 says "deleted").
 */
export const AUTO_DELETE = false;

/** D4: the founder's commitment to run due deletions within this many days of the scheduled date. */
export const DELETION_SLA_DAYS = 7;

/**
 * D11: maximum days deleted data may survive in backups (§9.3, Privacy §7).
 * Must be ≥ every retention mechanism: Neon's deleted-project recovery period is 7 days (per Neon docs,
 * Oct 2026). Any backup system added later must expire deleted tenants' data within this window.
 */
export const BACKUP_RETENTION_DAYS = 30;

/**
 * LB-D1 (feature-plan-launch-blockers.md §0): point-in-time history kept on every tenant Neon project — 7 days, the
 * Launch plan maximum. Mistake-undo backups (restore into a branch, RESTORE.md), not DCAA retention. Revisit on Scale.
 * Sent at project creation; existing projects via `npm run backfill:neon-retention`.
 */
export const TENANT_DB_HISTORY_RETENTION_SECONDS = 604_800;

/**
 * The retention actually requested: `NEON_HISTORY_RETENTION_SECONDS` overrides the policy value (a Free-plan staging
 * org rejects anything above 21600). A set-but-invalid value throws rather than silently falling back.
 */
export function tenantDbHistoryRetentionSeconds(): number {
  const raw = process.env.NEON_HISTORY_RETENTION_SECONDS?.trim();
  if (!raw) return TENANT_DB_HISTORY_RETENTION_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`NEON_HISTORY_RETENTION_SECONDS must be a non-negative integer number of seconds (got "${raw}").`);
  }
  return n;
}

// ── Read-only mode and export (Terms §3.2, §9.1, §9.2) ──────────────────────

/**
 * D5: roles that may download the full workspace export while the workspace is read-only.
 * All users can still sign in and view; employees and supervisors keep their normal role-scoped
 * views and downloads, but the whole-workspace export is admin-only in every mode.
 */
export const READ_ONLY_EXPORT_ROLES: readonly UserRole[] = ['admin'];

/** D6: after a subscription ends, admins export self-service from the read-only workspace (no support ticket). */
export const POST_END_SELF_SERVICE_EXPORT = true;

// ── Non-payment (Terms §4.7, §17) ───────────────────────────────────────────

/**
 * D7: days past due before suspension (§4.7). Counted from `past_due_since`: the first failed
 * charge, or the due date of an unpaid invoice. A `payment-failed` notice is sent on day 0.
 */
export const PAYMENT_GRACE_DAYS = 15;

/** D7: final `suspension-warning` notice, in days before suspension. */
export const SUSPENSION_NOTICE_DAYS = 3;

/** D8: admins of a suspended (unpaid) workspace may download the full export. */
export const SUSPENDED_EXPORT_ALLOWED = true;

/**
 * D9: days suspended before an unpaid workspace is terminated. At termination the cron cancels the
 * Stripe subscription, sets `subscription_ended_at`, and the workspace follows the normal
 * subscription-ended path (read-only + export, deletion after POST_END_RETENTION_DAYS).
 * Stripe's own dunning must be configured to NOT cancel subscriptions, so this cron is the only
 * thing that terminates for non-payment.
 */
export const SUSPENDED_DAYS_UNTIL_TERMINATION = 30;

// ── Notices (Terms §20.4) ───────────────────────────────────────────────────

/**
 * D10: who receives lifecycle notices: every active admin of the workspace, plus the Stripe
 * customer's billing email when one exists (deduplicated). If the workspace has no active admin,
 * fall back to the original signup email.
 */
export const NOTICE_RECIPIENTS = {
  activeAdmins: true,
  stripeBillingEmail: true,
  signupEmailFallbackOnly: true,
} as const;

// ── Export scope (Terms §1, §9.1) ───────────────────────────────────────────

/**
 * D12: tables in the full workspace export, beyond the §1 Customer Data tables listed in the
 * blueprint (T6). Login attempts, API-key metadata, and password-reset tokens are excluded
 * (security records, not Customer Data). Column allowlists still apply; no secrets are exported.
 */
export const EXPORT_EXTRA_TABLES: readonly string[] = [
  'notification_preferences',
  'integration_entity_mappings',
  'integration_sync_logs', // integration_sync_records.sync_log_id references these
  'integration_sync_records',
];

// ── Terms acceptance (checklist #1–2) ───────────────────────────────────────

/**
 * D13: version recorded with each signup's Terms acceptance. Format: `<effective date>[-draft-N]`.
 * Drop the `-draft-N` suffix and set the published effective date when the final Terms go live.
 */
export const TERMS_VERSION = '2026-10-21-draft-1';
