import { pgTable, uuid, varchar, text, timestamp, pgEnum, unique, boolean, integer, bigint, jsonb, uniqueIndex, index, primaryKey, char } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenantStatusEnum = pgEnum('tenant_status', [
  'provisioning', // DB being created/migrated/seeded
  'active',       // live and billable
  'suspended',    // access blocked (unpaid / admin action)
  'deleting',     // offboarding in progress
  'deleted',      // feature-plan-terms-compliance.md T7: tombstoned — db_url_encrypted nulled out
]);

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: varchar('slug', { length: 63 }).notNull().unique(), // subdomain label
  name: varchar('name', { length: 200 }).notNull(),
  // Encrypted (AES-256-GCM via src/lib/encryption.ts) tenant Postgres connection string.
  // T7: nulled out by tenant:delete at tombstoning — a deleted tenant has no database left to
  // point at, and keeping a stale encrypted URL around serves no purpose once it's gone.
  dbUrlEncrypted: text('db_url_encrypted'),
  status: tenantStatusEnum('status').notNull().default('provisioning'),
  plan: varchar('plan', { length: 40 }).notNull().default('trial'),
  // Billing fields (populated by the billing blueprint; nullable for now).
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 100 }),
  subscriptionStatus: varchar('subscription_status', { length: 40 }),
  // feature-plan-terms-compliance.md T1 — lifecycle facts (all nullable; src/lib/tenant/lifecycle.ts
  // derives the access mode from these, never the other way around). Instants (timestamptz), never
  // CalendarDate strings — these are deadlines, not calendar days.
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  pastDueSince: timestamp('past_due_since', { withTimezone: true }),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  subscriptionEndedAt: timestamp('subscription_ended_at', { withTimezone: true }),
  deletionScheduledFor: timestamp('deletion_scheduled_for', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // T7: the Neon project id, persisted at creation so deletion doesn't have to guess it.
  neonProjectId: varchar('neon_project_id', { length: 100 }),
  // T9 / R12: Terms acceptance, copied from the signups row at provisioning.
  termsVersion: varchar('terms_version', { length: 40 }),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  // T5: the Stripe event clock, so an out-of-order webhook delivery can't undo a newer one.
  lastStripeEventAt: timestamp('last_stripe_event_at', { withTimezone: true }),
  // D10 notice recipients: signupEmail is the fallback when there's no active admin; billingEmail
  // is kept current from Stripe (checkout.session.completed / customer.updated, T5).
  signupEmail: varchar('signup_email', { length: 255 }),
  billingEmail: varchar('billing_email', { length: 255 }),
  // feature-plan-terms-compliance-fixes.md §4.1 — billing/lifecycle state machine facts.
  // Set the first time the tracked subscription is GOOD (or DUNNING, which implies it was active); never cleared.
  firstGoodAt: timestamp('first_good_at', { withTimezone: true }),
  // From every Stripe read; drives the daily reconcile of a mirror that may be stale.
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  // 'nonpayment' (set by the cron) | 'policy' (set by the founder, Terms §17.3); null when not suspended.
  suspensionReason: varchar('suspension_reason', { length: 20 }),
  // F1: demo/internal workspaces skip the trial lifecycle. Set only by the demo seeder and tenant:admin.
  lifecycleExempt: boolean('lifecycle_exempt').notNull().default(false),
  // F5: a POLICY suspension blocks export by default; the founder may allow it per workspace (audited). Reset to
  // false whenever a policy suspension starts or ends.
  policyExportAllowed: boolean('policy_export_allowed').notNull().default(false),
  // The Stripe customer was deleted in the dashboard; the id is kept (never nulled) for history.
  stripeCustomerDeletedAt: timestamp('stripe_customer_deleted_at', { withTimezone: true }),
  // Cron rotation (oldest first) and repeated-failure alerting.
  lifecycleCheckedAt: timestamp('lifecycle_checked_at', { withTimezone: true }),
  lifecycleFailures: integer('lifecycle_failures').notNull().default(0),
  // THE concurrency guard for every lifecycle write (never compare timestamps for equality).
  lifecycleVersion: integer('lifecycle_version').notNull().default(0),
  // feature-plan-certified-outputs.md C1 (CO-D1 escape hatch): the founder reopened timesheet-history import for this
  // workspace until this instant (`tenant:admin reopen-import-window`). Read fresh inside every import batch.
  importWindowUntil: timestamp('import_window_until', { withTimezone: true }),
  // feature-plan-per-user-billing.md §6.2: the Standard price's interval ('month' | 'year' | null), written with `plan`
  // on a GOOD read of a Standard price; the tracked subscription's cancel-at-period-end flag and collection method
  // ('charge_automatically' | 'send_invoice'), from every tracked read.
  planInterval: varchar('plan_interval', { length: 10 }),
  subscriptionCancelAtPeriodEnd: boolean('subscription_cancel_at_period_end').notNull().default(false),
  collectionMethod: varchar('collection_method', { length: 30 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('tenants_stripe_customer_unique').on(table.stripeCustomerId).where(sql`${table.stripeCustomerId} IS NOT NULL`),
]);

/**
 * §3.3 / R14: the lifecycle notice OUTBOX and proof of every notice sent (src/lib/tenant/notices.ts).
 * Unique on (tenant_id, kind, scheduled_for = the cycle anchor), so re-enqueueing is a no-op. A row counts as
 * sent only with `sent_at` + `provider_message_id`; a founder override is `forced_at`, never `sent_at`.
 */
export const tenantNotices = pgTable('tenant_notices', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  kind: varchar('kind', { length: 60 }).notNull(),
  // The logical date/deadline this notice is FOR (e.g. the trial_ends_at instant, or the specific
  // reminder day) — not when it was actually sent. Part of the idempotency key.
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  recipients: text('recipients').array().notNull().default(sql`'{}'::text[]`),
  providerMessageId: varchar('provider_message_id', { length: 100 }),
  // §4.5 outbox: delivery attempts, the frozen message, supersession, and founder overrides.
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
  lastError: text('last_error'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  payload: jsonb('payload'),
  payloadFrozenAt: timestamp('payload_frozen_at', { withTimezone: true }),
  idempotencyGeneration: integer('idempotency_generation').notNull().default(0),
  forcedAt: timestamp('forced_at', { withTimezone: true }),
  forcedReason: text('forced_reason'),
  forcedAuditId: uuid('forced_audit_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('tenant_notices_tenant_kind_scheduled_unique').on(table.tenantId, table.kind, table.scheduledFor),
]);

export const signups = pgTable('signups', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 200 }).notNull(),
  slug: varchar('slug', { length: 63 }).notNull(),
  verifyTokenHash: varchar('verify_token_hash', { length: 64 }).notNull(),
  // D8: the signer's browser IANA timezone (Intl.DateTimeFormat().resolvedOptions().timeZone),
  // captured at signup and written into the new tenant's workspace_settings at provisioning.
  // Nullable/additive: validated before use, falls back to workspace_settings' own column
  // default if missing or invalid.
  timezone: varchar('timezone', { length: 100 }),
  // T9 / R12: Terms acceptance, recorded at signup and copied to the tenant row at provisioning.
  termsVersion: varchar('terms_version', { length: 40 }),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // feature-plan-launch-blockers.md P5 (LB-D2, LB-D5). ip_hash = sha256(SIGNUP_IP_SALT + ip or IPv6 /64) — the raw IP
  // is never stored — nulled after 24 h. A waitlisted signup IS a verified row (verified_at + waitlisted_at set,
  // consumed_at null) until the founder provisions it (provisioned_at).
  ipHash: varchar('ip_hash', { length: 64 }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  waitlistedAt: timestamp('waitlisted_at', { withTimezone: true }),
  provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
});

/** §4.3: founder-facing alerts, deduplicated while unresolved; read by the daily digest. */
export const opsAlerts = pgTable('ops_alerts', {
  id: uuid('id').defaultRandom().primaryKey(),
  scope: varchar('scope', { length: 64 }).notNull(), // tenant id, or 'global'
  tenantId: uuid('tenant_id').references(() => tenants.id),
  kind: varchar('kind', { length: 60 }).notNull(),
  dedupKey: varchar('dedup_key', { length: 200 }).notNull().default(''),
  detail: jsonb('detail'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  occurrences: integer('occurrences').notNull().default(1),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionNote: text('resolution_note'),
}, (table) => [
  uniqueIndex('ops_alerts_open_unique').on(table.scope, table.kind, table.dedupKey).where(sql`${table.resolvedAt} IS NULL`),
]);

/** §4.5: append-only record of founder and system actions that change a tenant's lifecycle. */
export const tenantAuditEvents = pgTable('tenant_audit_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  kind: varchar('kind', { length: 60 }).notNull(),
  detail: text('detail'),
  actor: varchar('actor', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('tenant_audit_events_tenant_idx').on(table.tenantId, table.createdAt),
]);

/**
 * §4.4: when reconcile first saw an open invoice with a payment in flight. A dedicated fact (never an alert row,
 * which can be resolved): the microdeposit window is cumulative per invoice and can't be reset.
 */
export const paymentPendingObservations = pgTable('payment_pending_observations', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  invoiceId: varchar('invoice_id', { length: 100 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(), // 'processing' | 'microdeposit'
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.invoiceId, table.kind] }),
]);

/**
 * LB-D7 (feature-plan-launch-blockers.md P6 §3): the free cron heartbeat — one row per cron, written at start and on
 * success. The daily digest lists any cron whose last success is older than its limit, or that has no row (never ran).
 * `last_summary` holds the run's JSON summary, including the reminder crons' fair-rotation `cursor`.
 */
export const cronRuns = pgTable('cron_runs', {
  name: varchar('name', { length: 60 }).primaryKey(),
  lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
  lastSucceededAt: timestamp('last_succeeded_at', { withTimezone: true }),
  lastSummary: jsonb('last_summary'),
});

/**
 * feature-plan-launch-blockers.md P5: small windowed counters (e.g. Turnstile outage signals per hour), shared by every
 * serverless instance — the in-memory limiter can't see across instances.
 */
export const signalCounters = pgTable('signal_counters', {
  key: varchar('key', { length: 100 }).primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
});

/**
 * feature-plan-per-user-billing.md §6.5: the seat-sync bookkeeping per tenant (never a lifecycle fact: no
 * lifecycle_version bump, its own `seats:` lock). `sync_due_at` is the oldest unserved due mark; `mark_seq` moves on
 * every mark so a run clears only the marks it served. `stripe_quantity` is the last quantity read or written for
 * `stripe_subscription_id`. ON DELETE CASCADE: tests delete tenant rows (production tombstones and never deletes).
 */
export const tenantSeatBilling = pgTable('tenant_seat_billing', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  syncDueAt: timestamp('sync_due_at', { withTimezone: true }),
  markSeq: bigint('mark_seq', { mode: 'number' }).notNull().default(0),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 100 }),
  stripeQuantity: integer('stripe_quantity'),
  billableCount: integer('billable_count'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  failures: integer('failures').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * feature-plan-database-backups.md §6.3: the backup system's records, written by the backup image's tasks (plain SQL with
 * explicit column lists, scripts/backup/lib/sql.ts) and read by the daily digest (src/lib/tenant/backup-status.ts).
 * Append-only except `restore_test_runs` (finished_at / status / detail / planned set once). Every table has `run_id`;
 * tests mark their rows with a run id starting `test-`. ON DELETE CASCADE: tests delete tenant rows (production
 * tombstones and never deletes).
 */
export const databaseBackups = pgTable('database_backups', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }), // null = the control plane
  target: varchar('target', { length: 20 }).notNull(), // 'tenant' | 'control-plane'
  runId: varchar('run_id', { length: 80 }).notNull(),
  status: varchar('status', { length: 10 }).notNull(), // 'ok' | 'failed'
  s3Key: text('s3_key'),
  bytes: bigint('bytes', { mode: 'number' }),
  sha256: char('sha256', { length: 64 }), // of the stored, encrypted object
  rowCounts: jsonb('row_counts'), // { "<schema>.<table>": number }
  serverVersion: varchar('server_version', { length: 40 }),
  pgDumpVersion: varchar('pg_dump_version', { length: 80 }),
  region: varchar('region', { length: 40 }), // parsed from the direct host; 'unknown' when it isn't a Neon host
  targetDeadlineMs: integer('target_deadline_ms').notNull(),
  error: text('error'), // an error summary (stage, codes, labels only: never a message line)
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('database_backups_tenant_status_idx').on(table.tenantId, table.status, table.finishedAt.desc()),
  index('database_backups_run_idx').on(table.runId),
  uniqueIndex('database_backups_s3_key_unique').on(table.s3Key).where(sql`${table.s3Key} IS NOT NULL`),
]);

/** §6.3 / §6.6: one row per daily audit run. */
export const backupAudits = pgTable('backup_audits', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: varchar('run_id', { length: 80 }).notNull(),
  runAt: timestamp('run_at', { withTimezone: true }).notNull(),
  oldestObjectAt: timestamp('oldest_object_at', { withTimezone: true }),
  oldestKey: text('oldest_key'),
  objectsOver29Days: integer('objects_over_29_days'),
  totalObjects: integer('total_objects'),
  totalBytes: bigint('total_bytes', { mode: 'number' }),
  versioningStatus: varchar('versioning_status', { length: 20 }), // '' = never enabled
  staleUploads: integer('stale_uploads'),
  kmsKeyState: varchar('kms_key_state', { length: 40 }),
  alertEmailConfirmed: boolean('alert_email_confirmed'), // null = the check failed
  protectionDrift: text('protection_drift'), // null = everything present and equal
  leftoverTestDbs: integer('leftover_test_dbs'), // null = sweep skipped (a restore test held the lock)
  stuckTestDbs: integer('stuck_test_dbs'),
  errors: text('errors'),
}, (table) => [
  index('backup_audits_run_at_idx').on(table.runAt),
]);

/** §6.3 / §6.7: one row per restore-test run. Not append-only: finished_at, status, planned and detail are set once. */
export const restoreTestRuns = pgTable('restore_test_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: varchar('run_id', { length: 80 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: varchar('status', { length: 10 }).notNull(), // 'running' | 'pass' | 'fail'
  planned: integer('planned'),
  sweptTestDbs: integer('swept_test_dbs').notNull().default(0),
  deadlineMs: integer('deadline_ms').notNull(),
  targetDeadlineMs: integer('target_deadline_ms').notNull(),
  detail: text('detail'),
}, (table) => [
  index('restore_test_runs_started_idx').on(table.startedAt),
]);

/** §6.3 / §6.7: one row per target tested. */
export const restoreTestResults = pgTable('restore_test_results', {
  id: uuid('id').defaultRandom().primaryKey(),
  testRunId: uuid('test_run_id').notNull().references(() => restoreTestRuns.id, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 80 }).notNull(),
  target: varchar('target', { length: 20 }).notNull(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  backupId: uuid('backup_id').references(() => databaseBackups.id, { onDelete: 'set null' }),
  s3Key: text('s3_key'),
  backupStartedAt: timestamp('backup_started_at', { withTimezone: true }),
  result: varchar('result', { length: 40 }).notNull(), // PASS | MISMATCH | FAIL:<stage>
  detail: text('detail'),
  durationMs: integer('duration_ms').notNull(),
  testedAt: timestamp('tested_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('restore_test_results_tenant_idx').on(table.tenantId, table.result, table.testedAt.desc()),
  index('restore_test_results_run_idx').on(table.testRunId),
]);

/** §6.3 / §6.13: one row per permission-probe set (each task probes what its role must NOT be able to do). */
export const backupPermissionChecks = pgTable('backup_permission_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: varchar('run_id', { length: 80 }).notNull(),
  role: varchar('role', { length: 20 }).notNull(), // 'backup' | 'audit' | 'restore-test'
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  ok: boolean('ok').notNull(),
  detail: jsonb('detail').notNull(),
}, (table) => [
  index('backup_permission_checks_role_idx').on(table.role, table.checkedAt),
]);

/**
 * feature-plan-disaster-restore.md §6.7: the disaster button's records, written by the backup image's `disaster` task
 * (plain SQL, scripts/backup/disaster.ts) and by migrate-all (`skip` rows, `reachable-again` proofs), read by the deploy
 * path (`--skip-lost`) and the daily digest (src/lib/tenant/disaster-status.ts). Ids only: no customer names.
 * `disaster_runs`: finished_at / status / summary set once at the end. `disaster_actions`: append-only; the latest row per
 * tenant and kind, or per project, is current. ON DELETE CASCADE: tests delete tenant rows (production tombstones).
 */
export const disasterRuns = pgTable('disaster_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: varchar('run_id', { length: 80 }).notNull(),
  mode: varchar('mode', { length: 20 }).notNull(), // 'workspace' | 'rehearse'
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: varchar('status', { length: 10 }).notNull(), // 'running' | 'pass' | 'fail'
  summary: jsonb('summary'),
}, (table) => [
  index('disaster_runs_started_idx').on(table.startedAt),
]);

export const disasterActions = pgTable('disaster_actions', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: varchar('run_id', { length: 80 }).notNull(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 20 }).notNull(), // 'proof' | 'rebuild' | 'rehearse' | 'skip'
  status: varchar('status', { length: 60 }).notNull(),
  projectName: varchar('project_name', { length: 100 }),
  newProjectId: varchar('new_project_id', { length: 100 }),
  oldProjectId: varchar('old_project_id', { length: 100 }),
  backupKey: text('backup_key'),
  backupStartedAt: timestamp('backup_started_at', { withTimezone: true }),
  detail: text('detail'),
  at: timestamp('at', { withTimezone: true }).notNull(),
}, (table) => [
  index('disaster_actions_tenant_idx').on(table.tenantId, table.kind, table.at.desc()),
  index('disaster_actions_project_idx').on(table.newProjectId),
]);

/**
 * feature-plan-cloud-export.md §6.5 (3d): one row per sent export (the "Export workspace" button's `deliver`), written by
 * the backup image's export task in the same transaction as its `export-ready` notice (`notice_id`) and audit event.
 * `token_encrypted` exists only until the notice is sent or superseded; `token_hash` (SHA-256 hex) is the page's lookup.
 * `recipients_encrypted` is an encrypt()ed JSON array: the exact addresses the notice goes to (never D10 at send time).
 * `extra_only` is true only when the policy-hold rule sent it to the verified extra address alone (A1). No cascade:
 * production tombstones tenants and never deletes them; the hourly sweep erases the S3 copy and sets `erased_at`.
 */
export const exportDeliveries = pgTable('export_deliveries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  noticeId: uuid('notice_id').notNull().unique('export_deliveries_notice_id_unique').references(() => tenantNotices.id),
  s3Key: text('s3_key').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique('export_deliveries_token_hash_unique'),
  tokenEncrypted: text('token_encrypted'),
  recipientsEncrypted: text('recipients_encrypted').notNull(),
  timeZone: varchar('time_zone', { length: 100 }).notNull(),
  extraRecipient: boolean('extra_recipient').notNull(),
  extraOnly: boolean('extra_only').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  downloadCount: integer('download_count').notNull().default(0),
  lastDownloadAt: timestamp('last_download_at', { withTimezone: true }),
  runId: varchar('run_id', { length: 80 }).notNull(),
}, (table) => [
  index('export_deliveries_tenant_created_idx').on(table.tenantId, table.createdAt),
]);

/**
 * feature-plan-cloud-export.md §6.3 `hold` (3d): a legal-hold copy in the exports bucket under `hold/`, kept until the
 * founder releases it (`release` deletes the object, verifies a 404, then sets `released_at`). Never served by the
 * download page and never expired by the sweep. No cascade (a hold survives the workspace's deletion by design).
 */
export const exportHolds = pgTable('export_holds', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  s3Key: text('s3_key').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  reason: text('reason').notNull(),
  runId: varchar('run_id', { length: 80 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releaseReason: text('release_reason'),
}, (table) => [
  index('export_holds_tenant_idx').on(table.tenantId, table.createdAt),
]);
