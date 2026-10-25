import { pgTable, uuid, varchar, text, timestamp, pgEnum, unique, boolean, integer, jsonb, uniqueIndex, index, primaryKey } from 'drizzle-orm/pg-core';
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
